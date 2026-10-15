import { getWorkspace, listWorkspaces, platformDb, platformReady } from "@/lib/platform";
import { platformAuditStatement } from "@/lib/platformAudit";
import { runInTenant } from "@/lib/tenant";
import { db, ready } from "@/lib/db";
import { findModel } from "@/lib/models";
import { UNSAVED_SQL, atRiskHorizon, isLostAge, type RiskCounts } from "@/lib/atRiskWindow";
import { atRiskCounts } from "@/lib/atRisk";

/**
 * Failed saves: renders that finished at the engine but whose file never reached our storage (a `succeeded` generation with no
 * `stored_url`), across every workspace. The heartbeat (app/api/cron/sync/route.ts) already tries to save each one every few
 * minutes; this is where the platform owner sees what it has not managed, and asks for one more try.
 *
 * Read-only on the workspaces' databases. The one write is the retry, which is the heartbeat's own path for one render
 * (lib/jobs.ts › syncGeneration): it polls the engine for the finished file and stores it. It starts no generation and spends
 * nothing the render had not already been charged; a take that was never charged stays as it was.
 */
/** `lost`: made more than 72 hours ago (lib/atRisk.ts), so nothing tries to save it any more; the console says "lost (older than 3 days)" instead of "at risk". */
export type FailedSave = { workspaceId: string; workspaceName: string; id: string; engine: string; since: number; lastError: string | null; lost: boolean };
export type FailedSaves = { items: FailedSave[]; /** Workspaces whose database could not be read just now. */ unreadable: number };

const PER_WORKSPACE = 50;
const TOTAL = 200;
const FRESH_MS = 30_000;
let cache: { at: number; value: FailedSaves } | null = null;

/** Drops the short-lived copy, so the next read is of the databases (after a retry, and in tests). */
export function forgetFailedSaves(): void { cache = null; }

export async function listFailedSaves(now = Date.now()): Promise<FailedSaves> {
  if (cache && now - cache.at < FRESH_MS) return cache.value;
  await platformReady();
  const items: FailedSave[] = [];
  let unreadable = 0;
  for (const ws of await listWorkspaces()) {
    try {
      const rows = await runInTenant(ws, async () => {
        await ready();
        const rs = await db().execute({
          sql: `SELECT g.id, g.model, g.error, g.created_at FROM generations g WHERE ${UNSAVED_SQL()} ORDER BY g.created_at DESC LIMIT ?`,
          args: [PER_WORKSPACE],
        });
        return rs.rows as unknown as Record<string, unknown>[];
      });
      for (const r of rows) {
        items.push({
          workspaceId: ws.id, workspaceName: ws.name, id: String(r.id), engine: findModel(String(r.model))?.label ?? String(r.model),
          since: Number(r.created_at), lastError: r.error ? String(r.error).slice(0, 300) : null, lost: isLostAge(Number(r.created_at), now),
        });
      }
    } catch { unreadable++; }
  }
  items.sort((a, b) => b.since - a.since);
  const value = { items: items.slice(0, TOTAL), unreadable };
  cache = { at: now, value };
  return value;
}

/**
 * How many unsaved takes there are across every workspace, at risk and lost, for the console's badge and its Overview tile (owner, 15 Oct 20:45: "show both, e.g. "1 at risk · 2 lost".
 * Lost takes were paid for and need my decision too."). Counted in each workspace's database, not from the list, so the figures are not cut off at the list's 200. Null when no workspace
 * could be read.
 */
export async function failedSavesCounts(): Promise<RiskCounts | null> {
  await platformReady();
  const total: RiskCounts = { atRisk: 0, lost: 0 };
  let read = 0, unreadable = 0;
  const horizon = atRiskHorizon();
  for (const ws of await listWorkspaces()) {
    try {
      const c = await runInTenant(ws, () => atRiskCounts(horizon));
      total.atRisk += c.atRisk; total.lost += c.lost; read++;
    } catch { unreadable++; }
  }
  return unreadable > 0 && read === 0 ? null : total;
}

export class RetryRefused extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** The save one more time, inside the workspace that owns the render. `sync` is the heartbeat's own path (injected so a test never reaches an engine). */
export async function retryFailedSave(
  input: { workspaceId: string; id: string; actorId: string },
  sync?: (id: string) => Promise<{ stored: boolean } | null>,
): Promise<{ saved: boolean }> {
  const ws = await getWorkspace(input.workspaceId);
  if (!ws || ws.deletedAt) throw new RetryRefused("No such workspace.", 404);
  const run = sync ?? (async (id: string) => {
    const { getGeneration, syncGeneration } = await import("@/lib/jobs");
    const gen = await getGeneration(id);
    if (!gen) return null;
    return { stored: Boolean((await syncGeneration(gen, { strict: true })).storedUrl) };
  });
  let saved = false, attempted = false;
  try {
    const result = await runInTenant(ws, async () => {
      await ready();
      /* Only a render that is in the list: finished, not deleted, and still with no stored file. */
      const rs = await db().execute({ sql: `SELECT 1 AS ok FROM generations WHERE id = ? AND status = 'succeeded' AND stored_url IS NULL AND deleted = 0`, args: [input.id] });
      if (!rs.rows.length) throw new RetryRefused("That render is not waiting for a save.", 404);
      attempted = true;
      return run(input.id);
    });
    saved = Boolean(result?.stored);
  } finally {
    forgetFailedSaves();
    /* A try is on the record whether or not it saved (and whether or not it threw); a refused one never started, so it leaves no line. */
    /* Its failure is logged and never changes the answer: a save that worked is not reported as an error because its line could not be written. */
    if (attempted) {
      try { await platformDb().execute(platformAuditStatement({ actorId: input.actorId, action: "save.retried", targetType: "take", targetId: input.id, workspaceId: input.workspaceId, details: { saved } })); }
      catch (error) { console.error(JSON.stringify({ level: "error", event: "platform_audit.write_failed", action: "save.retried", message: error instanceof Error ? error.message : "unknown" })); }
    }
  }
  return { saved };
}
