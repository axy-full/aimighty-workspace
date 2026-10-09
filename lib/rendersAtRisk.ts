import type { Client } from "@libsql/client";
import { db } from "./db";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";
import { mailConfigured, sendMail } from "./mail";
import { STORE_ERROR, STORE_FAILED_AT } from "./storeFailure";
import { atRiskItem, type AtRiskDesk, type AtRiskRender } from "./rendersAtRiskText";

/**
 * Renders at risk: paid renders with no stored copy (owner's decision,
 * 9 October 2026: "Any render with no stored copy after 1 hour → email to the
 * platform owner + a line in admin").
 *
 * A render is at risk when its master never reached our storage, so it plays
 * only from the provider's link, which expires:
 *   - status 'succeeded', not deleted, no stored_url, for more than an hour
 *     since it succeeded (settled_at; created_at on rows older than that
 *     column), or
 *   - a take still 'running' whose provider finished but whose save failed
 *     (fal video stays running, unbilled, until the save sticks), for more than
 *     an hour since saving first failed (params.storeFailedAt, lib/storeFailure.ts).
 *
 * The cron (app/api/cron/sync) records each workspace's at-risk renders as it
 * visits it, into one platform table, and after the visits, still under the
 * reconciliation lease, emails the platform owner (SUPER_ADMIN_EMAIL): once
 * when a render first appears, then at most once a day while any remain,
 * never when there are none. A render that gets stored, is deleted, or whose
 * workspace is deleted drops out. The marks live in the database, so several
 * server processes agree on what was sent. Nothing here ever fails the sweep:
 * every failure is logged as a JSON line and the sweep carries on.
 */

export const AT_RISK_AFTER_MS = 60 * 60_000;
export const AT_RISK_REMIND_MS = 24 * 60 * 60_000;
/** How many renders an email lists; the rest are counted. */
export const AT_RISK_MAIL_LIST = 20;
/** Per workspace per visit. Past it, nothing is cleared that visit (an unread row is not a stored one). */
const RECORD_LIMIT = 2000;

const EVENT = "renders.at_risk_alert";
const log = (level: "info" | "warn" | "error", fields: Record<string, unknown>) =>
  console[level](JSON.stringify({ level, event: EVENT, ...fields }));

const boot = new WeakMap<Client, Promise<void>>();
async function atRiskReady(): Promise<Client> {
  await platformReady();
  const client = platformDb();
  if (!boot.has(client))
    boot.set(client, client.batch([
      `CREATE TABLE IF NOT EXISTS render_at_risk (
        workspace_id TEXT NOT NULL, generation_id TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, billed INTEGER NOT NULL,
        since INTEGER NOT NULL, last_error TEXT,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        alerted_at INTEGER, mailed_at INTEGER, cleared_at INTEGER,
        PRIMARY KEY (workspace_id, generation_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_render_at_risk_open ON render_at_risk(cleared_at, since)`,
    ], "write").then(() => undefined).catch((error) => { boot.delete(client); throw error; }));
  await boot.get(client);
  return client;
}

/**
 * The visited workspace's renders at risk, recorded. Runs inside the cron's
 * tenant visit. Free: it reads our own databases and asks no provider.
 */
export async function recordRendersAtRisk(opts: { at?: number } = {}): Promise<{ open: number } | null> {
  const at = opts.at ?? Date.now();
  try {
    const workspaceId = requireTenant().id;
    const rs = await db().execute({
      sql: `SELECT id, COALESCE(provider,'byteplus') AS provider, model, status,
                   COALESCE(settled_at, created_at) AS settled,
                   json_extract(params,'${STORE_FAILED_AT}') AS failed_at,
                   json_extract(params,'${STORE_ERROR}') AS store_error
              FROM generations
             WHERE deleted=0 AND stored_url IS NULL
               AND (status='succeeded' OR (status IN ('queued','running') AND json_extract(params,'${STORE_FAILED_AT}') IS NOT NULL))
             ORDER BY created_at LIMIT ?`,
      args: [RECORD_LIMIT + 1],
    });
    const capped = rs.rows.length > RECORD_LIMIT;
    const found = rs.rows.slice(0, RECORD_LIMIT).flatMap((r) => {
      const billed = r.status === "succeeded";
      const since = Number(billed ? r.settled : r.failed_at);
      if (!Number.isFinite(since) || since > at - AT_RISK_AFTER_MS) return [];
      return [{
        id: String(r.id), provider: String(r.provider), model: String(r.model ?? ""), billed: billed ? 1 : 0, since,
        error: typeof r.store_error === "string" && r.store_error ? r.store_error : null,
      }];
    });
    const client = await atRiskReady();
    if (found.length)
      /* A render seen again keeps its alert; one that had dropped out and is back is new again. */
      await client.execute({
        sql: `INSERT INTO render_at_risk(workspace_id, generation_id, provider, model, billed, since, last_error, first_seen_at, last_seen_at)
              SELECT ?, json_extract(value,'$.id'), json_extract(value,'$.provider'), json_extract(value,'$.model'),
                     json_extract(value,'$.billed'), json_extract(value,'$.since'), json_extract(value,'$.error'), ?, ?
                FROM json_each(?) WHERE true
              ON CONFLICT(workspace_id, generation_id) DO UPDATE SET
                provider=excluded.provider, model=excluded.model, billed=excluded.billed, since=excluded.since,
                last_error=excluded.last_error, last_seen_at=excluded.last_seen_at,
                alerted_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.alerted_at END,
                mailed_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.mailed_at END,
                first_seen_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.first_seen_at ELSE excluded.first_seen_at END,
                cleared_at=NULL`,
        args: [workspaceId, at, at, JSON.stringify(found)],
      });
    /* Stored, deleted or otherwise no longer at risk: out of the alert and off the desk. */
    if (!capped)
      await client.execute({
        sql: `UPDATE render_at_risk SET cleared_at=? WHERE workspace_id=? AND cleared_at IS NULL
                AND generation_id NOT IN (SELECT value FROM json_each(?))`,
        args: [at, workspaceId, JSON.stringify(found.map((f) => f.id))],
      });
    return { open: found.length };
  } catch {
    log("error", { outcome: "record_failed" });
    return null;
  }
}

type OpenRow = AtRiskRender & { mailedAt: number | null };

async function openRenders(client: Client, limit: number, newFirst: boolean): Promise<{ total: number; fresh: number; oldestSince: number | null; lastMailAt: number | null; rows: OpenRow[] }> {
  const summary = (await client.execute(`SELECT COUNT(*) AS n, SUM(CASE WHEN alerted_at IS NULL THEN 1 ELSE 0 END) AS fresh,
      MIN(since) AS oldest, MAX(mailed_at) AS mailed FROM render_at_risk WHERE cleared_at IS NULL`)).rows[0];
  const rs = await client.execute({
    sql: `SELECT r.*, COALESCE(NULLIF(w.name,''), NULLIF(w.slug,''), r.workspace_id) AS workspace_name
            FROM render_at_risk r LEFT JOIN workspaces w ON w.id=r.workspace_id
           WHERE r.cleared_at IS NULL
           ORDER BY ${newFirst ? "(r.alerted_at IS NULL) DESC, " : ""}r.since, r.workspace_id, r.generation_id LIMIT ?`,
    args: [Math.max(1, limit)],
  });
  return {
    total: Number(summary?.n ?? 0),
    fresh: Number(summary?.fresh ?? 0),
    oldestSince: summary?.oldest == null ? null : Number(summary.oldest),
    lastMailAt: summary?.mailed == null ? null : Number(summary.mailed),
    rows: rs.rows.map((r) => ({
      workspaceId: String(r.workspace_id), workspace: String(r.workspace_name), generationId: String(r.generation_id),
      provider: String(r.provider), model: String(r.model), since: Number(r.since), billed: Number(r.billed) === 1,
      lastError: r.last_error == null ? null : String(r.last_error),
      alertedAt: r.alerted_at == null ? null : Number(r.alerted_at), mailedAt: r.mailed_at == null ? null : Number(r.mailed_at),
    })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function atRiskEmail(opts: { kind: "new" | "reminder"; total: number; fresh: number; rows: AtRiskRender[]; at: number }): { subject: string; text: string; html: string } {
  const n = (k: number) => `${k} render${k === 1 ? "" : "s"}`;
  const subject = opts.kind === "new"
    ? `Particl: ${n(opts.total)} with no stored copy`
    : `Particl reminder: ${n(opts.total)} still with no stored copy`;
  const lead = `${n(opts.total)} finished more than an hour ago and ${opts.total === 1 ? "has" : "have"} no copy in Particl's storage. ` +
    "Each plays only from the provider's link, which expires. The cron keeps trying to save them every 10 minutes for 3 days.";
  const newLine = opts.kind === "new" ? `New since the last email: ${opts.fresh}.` : "A daily reminder while any remain.";
  const items = opts.rows.map((r) => atRiskItem(r, opts.at));
  const more = opts.total > opts.rows.length ? `…and ${opts.total - opts.rows.length} more.` : null;
  const tail = "The platform desk (Admin › Renders at risk) lists every one.";
  const text = [lead, newLine, "", ...items.map((i) => `- ${i}`), ...(more ? [more] : []), "", tail].join("\n");
  const html = `<p>${esc(lead)}</p><p>${esc(newLine)}</p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>${more ? `<p>${esc(more)}</p>` : ""}<p>${esc(tail)}</p>`;
  return { subject, text, html };
}

/**
 * After the visits, under the reconciliation lease: email the platform owner
 * when a render is newly at risk, and once a day while any remain. Never
 * throws; a failed send leaves the marks as they were, so the next sweep tries again.
 */
export async function alertRendersAtRisk(opts: { at?: number } = {}): Promise<{ open: number; sent: "new" | "reminder" | null }> {
  const at = opts.at ?? Date.now();
  let open = 0;
  try {
    const client = await atRiskReady();
    /* A deleted workspace's renders are nobody's to rescue. */
    await client.execute({
      sql: `UPDATE render_at_risk SET cleared_at=? WHERE cleared_at IS NULL
              AND workspace_id NOT IN (SELECT id FROM workspaces WHERE deleted_at IS NULL)`,
      args: [at],
    });
    const state = await openRenders(client, AT_RISK_MAIL_LIST, true);
    open = state.total;
    if (!open) return { open, sent: null };
    const kind = state.fresh > 0 ? "new" : state.lastMailAt == null || state.lastMailAt <= at - AT_RISK_REMIND_MS ? "reminder" : null;
    if (!kind) return { open, sent: null };
    /* The platform's owner, as the deployment names it (read when needed, as lib/platform.ts isSuperAdmin does). */
    const owner = (process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
    if (!owner || !mailConfigured()) {
      log("warn", { outcome: "mail_unset", open, fresh: state.fresh });
      return { open, sent: null };
    }
    const mail = atRiskEmail({ kind, total: open, fresh: state.fresh, rows: state.rows, at });
    try {
      await sendMail({ to: owner, ...mail });
    } catch {
      log("error", { outcome: "send_failed", kind, open, fresh: state.fresh });
      return { open, sent: null };
    }
    await client.execute({
      sql: "UPDATE render_at_risk SET alerted_at=COALESCE(alerted_at,?), mailed_at=? WHERE cleared_at IS NULL",
      args: [at, at],
    });
    log("info", { outcome: "sent", kind, open, fresh: state.fresh });
    return { open, sent: kind };
  } catch {
    log("error", { outcome: "failed", open });
    return { open, sent: null };
  }
}

/** The platform desk's line and list: count, oldest, and the renders oldest first. */
export async function rendersAtRiskDesk(limit = 50): Promise<AtRiskDesk> {
  const client = await atRiskReady();
  const state = await openRenders(client, Math.min(200, limit), false);
  return {
    at: Date.now(), count: state.total, oldestSince: state.oldestSince, lastMailAt: state.lastMailAt,
    renders: state.rows.map((r) => ({
      workspaceId: r.workspaceId, workspace: r.workspace, generationId: r.generationId, provider: r.provider, model: r.model,
      since: r.since, billed: r.billed, lastError: r.lastError, alertedAt: r.alertedAt,
    })),
  };
}
