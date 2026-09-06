import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { creditState } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { meter } from "./meter";
import { enqueueRender } from "./inngest";
import { runInline } from "./renderWork";
import { submitVideoRow } from "./submitVideo";
import { invalidate, PROJECTS_KEY } from "./cache";
import { sendPushTo } from "./push";
import { sendMail, mailConfigured } from "./mail";
import { workspaceAdmins } from "./platform";
import { workspaceLimits, standing } from "./limits";

/**
 * The hard stop at zero.
 *
 * A workspace that runs out of credits does not get refused: the take is
 * written with everything needed to run it and parked as `held`. No engine
 * is asked and nothing is billed. The moment credits arrive — a grant, a
 * top-up, or the cron finding the balance restored — held takes are
 * released oldest first, and the first one that does not fit stops the
 * line, so the balance is never spent out of order. The owner and admins
 * hear once, when the first take is held.
 */
export const HELD_LIMIT = 20;
export type HeldWhy = "credits" | "slots";
export type HeldInfo = { estUsd: number; needs: number; at: number; why: HeldWhy };
type Defer = (fn: () => Promise<void>) => void;

export function heldInfo(estUsd: number, kind: string, model: string, why: HeldWhy = "credits"): HeldInfo {
  return { estUsd, needs: billCredits(estUsd, marginKeyOf(kind, model)), at: now(), why };
}

export function heldMessage(needs: number, left: number): string {
  const l = Math.max(0, Math.floor(left));
  return `Held: this needs ${needs} credit${needs === 1 ? "" : "s"} and ${l} ${l === 1 ? "is" : "are"} left. Top up to release it — nothing is lost.`;
}

export async function heldCount(): Promise<number> {
  await ready();
  const rs = await db().execute(`SELECT COUNT(*) AS n FROM generations WHERE status = 'held' AND deleted = 0`);
  return Number((rs.rows[0] as { n?: number })?.n ?? 0);
}

/** Oldest first; the first take that does not fit stops the line. A null balance means credits do not apply. */
export function planRelease(held: { id: string; needs: number }[], balance: number | null): { release: string[]; short: string[] } {
  if (balance == null) return { release: held.map((h) => h.id), short: [] };
  const release: string[] = [];
  let left = balance;
  let i = 0;
  for (; i < held.length; i++) {
    if (held[i].needs > left) break;
    release.push(held[i].id);
    left -= held[i].needs;
  }
  return { release, short: held.slice(i).map((h) => h.id) };
}

type HeldRow = {
  id: string; kind: "video" | "image" | "audio"; model: string; engine: string;
  projectId: string | null; shotId: string | null; createdBy: string | null;
  estUsd: number; needs: number; why: HeldWhy;
};

async function heldRows(only?: string): Promise<HeldRow[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id, kind, model, billed_to, provider, project_id, shot_id, created_by, params
          FROM generations WHERE status = 'held' AND deleted = 0 ${only ? "AND id = ?" : ""}
          ORDER BY created_at ASC LIMIT 50`,
    args: only ? [only] : [],
  });
  return rs.rows.map((r) => {
    const row = r as unknown as Record<string, unknown>;
    let held: Partial<HeldInfo> = {};
    try { held = (JSON.parse(String(row.params ?? "{}")) as { held?: Partial<HeldInfo> }).held ?? {}; } catch { held = {}; }
    const kind = (row.kind === "image" || row.kind === "audio" ? row.kind : "video") as HeldRow["kind"];
    const model = String(row.model);
    const estUsd = Number(held.estUsd ?? 0);
    return {
      id: String(row.id), kind, model,
      engine: String(row.billed_to ?? row.provider ?? "byteplus"),
      projectId: (row.project_id as string | null) ?? null, shotId: (row.shot_id as string | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      estUsd, needs: Number(held.needs ?? billCredits(estUsd, marginKeyOf(kind, model))),
      why: held.why === "slots" ? "slots" : "credits",
    };
  });
}

/**
 * Release what the balance now covers. `only` releases one take (a person
 * pressing Release); `defer` is how the caller keeps the render alive past
 * its response (Next's `after` inside a request).
 */
export async function releaseHeldJobs(opts: { only?: string; defer?: Defer } = {}): Promise<{ released: string[]; short: number }> {
  const rows = await heldRows(opts.only);
  if (!rows.length) return { released: [], short: 0 };
  const state = await creditState();
  /* Credits are checked for the takes held for credits; a slot is needed by
     every release, whatever it was held for. */
  const plan = planRelease(rows.filter((r) => r.why === "credits"), state ? state.balance : null);
  const [limits, st] = await Promise.all([workspaceLimits(), standing()]);
  let running = st.running;
  const defer: Defer = opts.defer ?? ((fn) => { void fn().catch((e) => console.error("release:", (e as Error).message)); });
  const released: string[] = [];
  for (const r of rows) {
    if (running >= limits.concurrency) break;
    if (r.why === "credits" && !plan.release.includes(r.id)) break;
    // The meter first: work the platform cannot bill does not start.
    try {
      await meter({ id: r.id, kind: r.kind, engine: r.engine, model: r.model, status: "running",
                    engineCostUsd: r.estUsd, projectId: r.projectId, shotId: r.shotId, createdBy: r.createdBy });
    } catch (e) {
      console.error(`release ${r.id}: not metered —`, (e as Error).message);
      break;
    }
    const t = now();
    const next = r.kind === "video" ? "queued" : "running";
    // The clock restarts: the janitor measures a take from when it was sent, and it is sent now.
    const upd = await db().execute({
      sql: `UPDATE generations
            SET status = ?, created_at = ?, updated_at = ?,
                params = json_remove(json_set(params, '$.releasedAt', ?), '$.held')
            WHERE id = ? AND status = 'held'`,
      args: [next, t, t, t, r.id],
    });
    if (!upd.rowsAffected) continue;
    if (r.kind === "video") defer(async () => { await submitVideoRow(r.id); });
    else if (!(await enqueueRender(r.id, r.kind))) defer(() => runInline(r.id));
    released.push(r.id);
    running += 1;
  }
  if (released.length) invalidate(PROJECTS_KEY);
  return { released, short: rows.length - released.length };
}

function siteUrl(): string {
  const raw = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return raw.replace(/\/$/, "");
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** Tell the owner and admins, once per episode: the first take held while nothing else was. */
export async function notifyHeld(gen: { id: string; needs: number; left: number }): Promise<void> {
  const ws = currentTenant()?.workspace;
  if (!ws) return;
  if ((await heldCount()) !== 1) return;
  const admins = await workspaceAdmins(ws.id).catch(() => [] as { id: string; email: string; name: string }[]);
  if (!admins.length) return;
  const title = "Renders are being held";
  const body = `A take needs ${gen.needs} credits and ${Math.max(0, Math.floor(gen.left))} are left. Top up to release it — nothing is lost.`;
  await sendPushTo(admins.map((a) => a.id), { title, body, url: "/settings#credits" }).catch(() => {});
  if (!mailConfigured()) return;
  const link = `${siteUrl()}/settings#credits`;
  await Promise.allSettled(admins.filter((a) => a.email).map((a) => sendMail({
    to: a.email,
    subject: `${ws.name}: ${title}`,
    text: `${body}\n\n${link}`,
    html: `<p>${esc(body)}</p><p><a href="${esc(link)}">Open Settings</a></p>`,
  })));
}
