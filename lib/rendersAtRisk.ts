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
 *     (fal video stays running, unbilled, until a save succeeds), for more than
 *     an hour since saving first failed (params.storeFailedAt, lib/storeFailure.ts).
 *
 * Each render has a retry window: the cron tries to save a succeeded render
 * until 3 days after it was created (syncPending's horizon in lib/jobs.ts), and
 * for a fal take the window is 3 days from its first failed save. A render past
 * its window is "lost": it is reported once, in the next email, and stays on
 * the admin desk, but is never in a reminder.
 *
 * The cron (app/api/cron/sync) records each workspace's at-risk renders as it
 * visits it, into one platform table, and after the visits, still under the
 * reconciliation lease, emails the platform owner (SUPER_ADMIN_EMAIL): when a
 * render is new (or newly lost), and at most once a day while any render inside
 * its window remains; never when there is nothing new and nothing inside a
 * window. A render that gets stored, is deleted, or whose workspace is deleted
 * drops out. The marks live in the database, so several server processes agree
 * on what was sent. Nothing here ever fails the sweep: every failure is logged
 * as a JSON line and the sweep goes on.
 */

export const AT_RISK_AFTER_MS = 60 * 60_000;
export const AT_RISK_REMIND_MS = 24 * 60 * 60_000;
/** The cron's save window: syncPending retries a succeeded render created within it (lib/jobs.ts). */
export const RETRY_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Rows that dropped out are kept this long, then deleted. */
const CLEARED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** How many renders an email lists; the rest are counted. */
export const AT_RISK_MAIL_LIST = 20;
/** Per workspace per visit, newest first. Past it, nothing is cleared that visit (an unread row is not a stored one). */
const RECORD_LIMIT = 2000;
/** Joins a workspace id and a generation id into one key for json_each. */
const SEP = "\u001f";

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
        since INTEGER NOT NULL, retry_until INTEGER NOT NULL, last_error TEXT,
        first_seen_at INTEGER NOT NULL,
        alerted_at INTEGER, mailed_at INTEGER, lost_reported_at INTEGER, cleared_at INTEGER,
        PRIMARY KEY (workspace_id, generation_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_render_at_risk_open ON render_at_risk(cleared_at, since)`,
    ], "write").then(() => undefined).catch((error) => { boot.delete(client); throw error; }));
  await boot.get(client);
  return client;
}

/**
 * The visited workspace's renders at risk, recorded. Runs inside the cron's
 * tenant visit. Free: it reads our own databases and asks no provider. A row
 * is written only when something about it changed.
 */
export async function recordRendersAtRisk(opts: { at?: number } = {}): Promise<{ open: number } | null> {
  const at = opts.at ?? Date.now();
  try {
    const workspaceId = requireTenant().id;
    const rs = await db().execute({
      sql: `SELECT id, COALESCE(provider,'byteplus') AS provider, model, status, created_at,
                   COALESCE(settled_at, created_at) AS settled,
                   json_extract(params,'${STORE_FAILED_AT}') AS failed_at,
                   json_extract(params,'${STORE_ERROR}') AS store_error
              FROM generations
             WHERE deleted=0 AND stored_url IS NULL
               AND (status='succeeded' OR (status IN ('queued','running') AND json_extract(params,'${STORE_FAILED_AT}') IS NOT NULL))
             ORDER BY created_at DESC LIMIT ?`,
      args: [RECORD_LIMIT + 1],
    });
    const capped = rs.rows.length > RECORD_LIMIT;
    const found = rs.rows.slice(0, RECORD_LIMIT).flatMap((r) => {
      const billed = r.status === "succeeded";
      const since = Number(billed ? r.settled : r.failed_at);
      if (!Number.isFinite(since) || since > at - AT_RISK_AFTER_MS) return [];
      /* A succeeded render is retried until 3 days after it was created; a fal take, 3 days from its first failed save. */
      const retryUntil = (billed ? Number(r.created_at) : since) + RETRY_WINDOW_MS;
      return [{
        id: String(r.id), provider: String(r.provider), model: String(r.model ?? ""), billed: billed ? 1 : 0, since, retryUntil,
        error: typeof r.store_error === "string" && r.store_error ? r.store_error : null,
      }];
    });
    const client = await atRiskReady();
    if (found.length)
      /* A render seen again keeps its marks; one that had dropped out and is back is new again. Unchanged rows are not written. */
      await client.execute({
        sql: `INSERT INTO render_at_risk(workspace_id, generation_id, provider, model, billed, since, retry_until, last_error, first_seen_at)
              SELECT ?, json_extract(value,'$.id'), json_extract(value,'$.provider'), json_extract(value,'$.model'),
                     json_extract(value,'$.billed'), json_extract(value,'$.since'), json_extract(value,'$.retryUntil'),
                     json_extract(value,'$.error'), ?
                FROM json_each(?) WHERE true
              ON CONFLICT(workspace_id, generation_id) DO UPDATE SET
                provider=excluded.provider, model=excluded.model, billed=excluded.billed, since=excluded.since,
                retry_until=excluded.retry_until, last_error=excluded.last_error,
                alerted_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.alerted_at END,
                mailed_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.mailed_at END,
                lost_reported_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.lost_reported_at END,
                first_seen_at=CASE WHEN render_at_risk.cleared_at IS NULL THEN render_at_risk.first_seen_at ELSE excluded.first_seen_at END,
                cleared_at=NULL
              WHERE render_at_risk.cleared_at IS NOT NULL
                 OR render_at_risk.provider IS NOT excluded.provider OR render_at_risk.model IS NOT excluded.model
                 OR render_at_risk.billed IS NOT excluded.billed OR render_at_risk.since IS NOT excluded.since
                 OR render_at_risk.retry_until IS NOT excluded.retry_until OR render_at_risk.last_error IS NOT excluded.last_error`,
        args: [workspaceId, at, JSON.stringify(found)],
      });
    /* Stored, deleted or otherwise no longer at risk: out of the alert and off the desk. Written only when there is one. */
    if (!capped) {
      const seen = new Set(found.map((f) => f.id));
      const open = (await client.execute({
        sql: "SELECT generation_id FROM render_at_risk WHERE workspace_id=? AND cleared_at IS NULL", args: [workspaceId],
      })).rows.map((r) => String(r.generation_id));
      const gone = open.filter((id) => !seen.has(id));
      if (gone.length)
        await client.execute({
          sql: `UPDATE render_at_risk SET cleared_at=? WHERE workspace_id=? AND cleared_at IS NULL
                  AND generation_id IN (SELECT value FROM json_each(?))`,
          args: [at, workspaceId, JSON.stringify(gone)],
        });
    }
    return { open: found.length };
  } catch {
    log("error", { outcome: "record_failed" });
    return null;
  }
}

type OpenRow = AtRiskRender & { mailedAt: number | null; lostReportedAt: number | null };
type OpenState = {
  total: number; inWindow: number; lost: number; fresh: number; freshLost: number; lostReported: number;
  oldestSince: number | null; lastMailAt: number | null; rows: OpenRow[];
};

/**
 * The open renders at `at`. `mail`: only what an email may name (inside its
 * window, or lost and not yet reported), new ones first; otherwise every open
 * render, oldest first.
 */
async function openRenders(client: Client, at: number, limit: number, mail: boolean): Promise<OpenState> {
  const s = (await client.execute({
    sql: `SELECT COUNT(*) AS n,
            SUM(CASE WHEN retry_until > ? THEN 1 ELSE 0 END) AS in_window,
            SUM(CASE WHEN retry_until > ? AND alerted_at IS NULL THEN 1 ELSE 0 END) AS fresh_window,
            SUM(CASE WHEN retry_until <= ? AND lost_reported_at IS NULL THEN 1 ELSE 0 END) AS fresh_lost,
            SUM(CASE WHEN retry_until <= ? AND lost_reported_at IS NOT NULL THEN 1 ELSE 0 END) AS lost_reported,
            MIN(since) AS oldest,
            MAX(mailed_at) AS mailed_any,
            MAX(CASE WHEN retry_until > ? THEN mailed_at END) AS mailed_window
          FROM render_at_risk WHERE cleared_at IS NULL`,
    args: [at, at, at, at, at],
  })).rows[0];
  const select = `SELECT r.*, COALESCE(NULLIF(w.name,''), NULLIF(w.slug,''), r.workspace_id) AS workspace_name
            FROM render_at_risk r LEFT JOIN workspaces w ON w.id=r.workspace_id WHERE r.cleared_at IS NULL`;
  const rs = await client.execute(mail
    ? {
      sql: `${select} AND (r.retry_until > ? OR r.lost_reported_at IS NULL)
            ORDER BY (CASE WHEN r.retry_until > ? THEN r.alerted_at IS NULL ELSE 1 END) DESC, r.since, r.workspace_id, r.generation_id LIMIT ?`,
      args: [at, at, Math.max(1, limit)],
    }
    : { sql: `${select} ORDER BY r.since, r.workspace_id, r.generation_id LIMIT ?`, args: [Math.max(1, limit)] });
  const total = Number(s?.n ?? 0);
  const inWindow = Number(s?.in_window ?? 0);
  const freshLost = Number(s?.fresh_lost ?? 0);
  /* The reminder's clock counts only renders inside their window; the desk shows the last email of any. */
  const mailed = mail ? s?.mailed_window : s?.mailed_any;
  return {
    total, inWindow, lost: total - inWindow, freshLost, lostReported: Number(s?.lost_reported ?? 0),
    fresh: Number(s?.fresh_window ?? 0) + freshLost,
    oldestSince: s?.oldest == null ? null : Number(s.oldest),
    lastMailAt: mailed == null ? null : Number(mailed),
    rows: rs.rows.map((r) => ({
      workspaceId: String(r.workspace_id), workspace: String(r.workspace_name), generationId: String(r.generation_id),
      provider: String(r.provider), model: String(r.model), since: Number(r.since), billed: Number(r.billed) === 1,
      lost: Number(r.retry_until) <= at,
      lastError: r.last_error == null ? null : String(r.last_error),
      alertedAt: r.alerted_at == null ? null : Number(r.alerted_at), mailedAt: r.mailed_at == null ? null : Number(r.mailed_at),
      lostReportedAt: r.lost_reported_at == null ? null : Number(r.lost_reported_at),
    })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function atRiskEmail(opts: {
  kind: "new" | "reminder"; total: number; fresh: number; freshLost: number; lostReported: number; rows: AtRiskRender[]; at: number;
}): { subject: string; text: string; html: string } {
  const n = (k: number) => `${k} render${k === 1 ? "" : "s"}`;
  const subject = opts.kind === "new"
    ? `Particl: ${n(opts.total)} with no stored copy`
    : `Particl reminder: ${n(opts.total)} still with no stored copy`;
  const paragraphs = [
    `${n(opts.total)} finished more than an hour ago and ${opts.total === 1 ? "is" : "are"} not in Particl's storage. ` +
      "Each one plays only from the provider's link, and that link expires.",
    "The cron tries to save a render every 10 minutes until 3 days after the render was created. " +
      "A fal take is tried until fal no longer has the job.",
    opts.kind === "new"
      ? `New since the last email: ${opts.fresh}.` + (opts.freshLost
        ? ` ${n(opts.freshLost)} marked "lost" ${opts.freshLost === 1 ? "is" : "are"} past the 3-day window. This email is the only one about ${opts.freshLost === 1 ? "it" : "them"}.`
        : "")
      : "This reminder is sent once a day while a render inside its 3-day window has no stored copy.",
  ];
  const items = opts.rows.map((r) => atRiskItem(r, opts.at));
  const more = opts.total > opts.rows.length ? `…and ${opts.total - opts.rows.length} more.` : null;
  const tail = [
    ...(opts.lostReported ? [`${n(opts.lostReported)} already reported as lost ${opts.lostReported === 1 ? "is" : "are"} not in this email.`] : []),
    "The admin desk (Admin › Renders at risk) lists every one.",
  ];
  const text = [...paragraphs, "", ...items.map((i) => `- ${i}`), ...(more ? [more] : []), "", ...tail].join("\n");
  const html = `${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>${more ? `<p>${esc(more)}</p>` : ""}${tail.map((p) => `<p>${esc(p)}</p>`).join("")}`;
  return { subject, text, html };
}

/**
 * After the visits, under the reconciliation lease: email the platform owner
 * when a render is new or newly lost, and once a day while any render inside
 * its window remains. Never throws; a failed send leaves the marks as they
 * were, so the next sweep tries again. Only the renders the email names are marked.
 */
export async function alertRendersAtRisk(opts: { at?: number } = {}): Promise<{ open: number; sent: "new" | "reminder" | null }> {
  const at = opts.at ?? Date.now();
  let open = 0;
  try {
    const client = await atRiskReady();
    await client.execute({
      sql: "DELETE FROM render_at_risk WHERE cleared_at IS NOT NULL AND cleared_at < ?",
      args: [at - CLEARED_KEEP_MS],
    });
    /* A deleted workspace's renders will not be saved by anyone. */
    await client.execute({
      sql: `UPDATE render_at_risk SET cleared_at=? WHERE cleared_at IS NULL
              AND workspace_id NOT IN (SELECT id FROM workspaces WHERE deleted_at IS NULL)`,
      args: [at],
    });
    const state = await openRenders(client, at, AT_RISK_MAIL_LIST, true);
    open = state.total;
    if (!open) return { open, sent: null };
    const kind = state.fresh > 0
      ? "new"
      : state.inWindow > 0 && (state.lastMailAt == null || state.lastMailAt <= at - AT_RISK_REMIND_MS) ? "reminder" : null;
    if (!kind) return { open, sent: null };
    /* The platform's owner, as the deployment names it (read when needed, as lib/platform.ts isSuperAdmin does). */
    const owner = (process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
    if (!owner || !mailConfigured()) {
      log("warn", { outcome: "mail_unset", open, fresh: state.fresh });
      return { open, sent: null };
    }
    const mailable = state.inWindow + state.freshLost;
    const mail = atRiskEmail({ kind, total: mailable, fresh: state.fresh, freshLost: state.freshLost, lostReported: state.lostReported, rows: state.rows, at });
    try {
      await sendMail({ to: owner, ...mail });
    } catch {
      log("error", { outcome: "send_failed", kind, open, fresh: state.fresh });
      return { open, sent: null };
    }
    await client.execute({
      sql: `UPDATE render_at_risk SET alerted_at=COALESCE(alerted_at,?), mailed_at=?,
              lost_reported_at=CASE WHEN retry_until <= ? THEN COALESCE(lost_reported_at,?) ELSE lost_reported_at END
            WHERE cleared_at IS NULL AND (workspace_id || char(31) || generation_id) IN (SELECT value FROM json_each(?))`,
      args: [at, at, at, at, JSON.stringify(state.rows.map((r) => `${r.workspaceId}${SEP}${r.generationId}`))],
    });
    log("info", { outcome: "sent", kind, open, fresh: state.fresh, listed: state.rows.length });
    return { open, sent: kind };
  } catch {
    log("error", { outcome: "failed", open });
    return { open, sent: null };
  }
}

/** The platform desk's line and list: count, how many are lost, the oldest, and the renders oldest first. */
export async function rendersAtRiskDesk(opts: { limit?: number; at?: number } = {}): Promise<AtRiskDesk> {
  const client = await atRiskReady();
  const at = opts.at ?? Date.now();
  const state = await openRenders(client, at, Math.min(200, opts.limit ?? 50), false);
  return {
    at, count: state.total, lost: state.lost, oldestSince: state.oldestSince, lastMailAt: state.lastMailAt,
    renders: state.rows.map((r) => ({
      workspaceId: r.workspaceId, workspace: r.workspace, generationId: r.generationId, provider: r.provider, model: r.model,
      since: r.since, billed: r.billed, lost: r.lost, lastError: r.lastError, alertedAt: r.alertedAt,
    })),
  };
}
