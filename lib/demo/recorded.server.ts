import { db, ready } from "../db";
import { platformDb, platformReady } from "../platform";
import { requireTenant } from "../tenant";
import type { RecordedJob, SampleShotRow } from "./plan";

/*
 * The production's own rows and what the ledger recorded for them, read-only and scoped to this workspace. Only
 * credits are read from the ledger (its settled charge or its reservation); the vendor dollars beside them are not
 * selected at all, so they cannot reach a screen. Nothing is written.
 */

const CHUNK = 200;

type Params = { duration?: unknown; resolution?: unknown };
const parseParams = (raw: unknown): Params => {
  try { const value = JSON.parse(String(raw ?? "{}")); return value && typeof value === "object" ? (value as Params) : {}; } catch { return {}; }
};
const positive = (value: unknown): number | null => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };

/** What the ledger holds for these jobs in this workspace: credits, and whether that is the settled charge. Nothing for a job it has no row for. */
export async function ledgerCreditsFor(ids: readonly string[]): Promise<Map<string, { credits: number; settled: boolean }>> {
  const out = new Map<string, { credits: number; settled: boolean }>();
  if (!ids.length) return out;
  const workspaceId = requireTenant().id;
  await platformReady();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rs = await platformDb().execute({
      sql: `SELECT id, status, billed_credits FROM meter_events
            WHERE workspace_id = ? AND paid_by_platform = 1 AND billed_credits IS NOT NULL AND id IN (${chunk.map(() => "?").join(",")})`,
      args: [workspaceId, ...chunk],
    });
    for (const r of rs.rows) out.set(String(r.id), { credits: Number(r.billed_credits), settled: String(r.status) === "succeeded" });
  }
  return out;
}

export type ProductionRows = { shots: SampleShotRow[]; jobs: RecordedJob[] };

/** The production's shots (production order) and its succeeded jobs, each with its recorded credits. */
export async function readProductionRows(productionId: string): Promise<ProductionRows> {
  await ready();
  const [shots, gens] = await Promise.all([
    db().execute({ sql: `SELECT id, position FROM shots WHERE project_id = ? ORDER BY position, created_at, id`, args: [productionId] }),
    db().execute({
      sql: `SELECT id, kind, model, shot_id, version, review_state, params, duration_s, created_at FROM generations
            WHERE project_id = ? AND deleted = 0 AND status = 'succeeded' ORDER BY created_at, id`,
      args: [productionId],
    }),
  ]);
  const ledger = await ledgerCreditsFor(gens.rows.map((r) => String(r.id)));
  const jobs = gens.rows.map((r): RecordedJob => {
    const params = parseParams(r.params);
    const recorded = ledger.get(String(r.id));
    return {
      id: String(r.id), kind: String(r.kind ?? "video"), model: String(r.model ?? ""),
      shotId: r.shot_id == null ? null : String(r.shot_id), version: Number(r.version ?? 1), approved: r.review_state === "approved",
      seconds: positive(r.duration_s) ?? positive(params.duration), resolution: typeof params.resolution === "string" && params.resolution ? params.resolution : null,
      createdAt: Number(r.created_at ?? 0), credits: recorded ? recorded.credits : null, settled: recorded ? recorded.settled : false,
    };
  });
  return { shots: shots.rows.map((r) => ({ id: String(r.id), position: Number(r.position ?? 0) })), jobs };
}
