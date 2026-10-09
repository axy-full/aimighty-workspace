import { db, ready } from "../db";
import { platformDb, platformReady } from "../platform";
import { cached, putCache } from "../cache";
import { samplesByModel, typicalTable, type TypicalTimesReply } from "./typicalTimes";
import { engineMock } from "../mock";

/**
 * Typical render times from real job history (redesign plan, decision 9), for
 * GET /api/v12/typical-times.
 *
 * Two sources, the platform's first so a small workspace still gets figures:
 *
 * - every workspace's settled takes in the meter (meter_events, the one place
 *   the platform reads across workspaces, as lib/meter.ts engineHealth does).
 *   Only `model` and `duration_ms` are read, only for engines in the product's
 *   own catalogue (no other workspace's ids, costs or names reach anyone), and
 *   the answer is the middle half of the durations, never a row or a count;
 * - this workspace's own takes (generations, its own database), for an engine
 *   the platform has too few of.
 *
 * Both reads are bounded and index-led: the meter by rowid (its table b-tree's
 * own key, so only the newest METER_WINDOW rows are visited; meter_events has
 * no index on created_at alone), the workspace's takes by idx_gen_created. The
 * answer is memoised briefly: per server for the platform's part, per
 * workspace for the whole reply.
 */

/** How far back history counts. */
export const HISTORY_MS = 30 * 24 * 3_600_000;
/** The newest meter rows visited (across every workspace) and the newest takes of this workspace read. */
export const METER_WINDOW = 20_000;
export const WORKSPACE_LIMIT = 2_000;
/** How long an answer is reused. A local mock server (ENGINE_MOCK=1) reads afresh every time, so its specs see their own rows. */
export const TYPICAL_TTL_MS = 5 * 60_000;
const ttl = () => (engineMock() ? 0 : TYPICAL_TTL_MS);
const KEY = "v12:typical-times";

let platformMemo: { at: number; samples: Map<string, number[]> } | null = null;

async function platformSamples(at: number): Promise<Map<string, number[]>> {
  if (platformMemo && at - platformMemo.at < ttl()) return platformMemo.samples;
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT model, duration_ms FROM meter_events
          WHERE rowid > (SELECT COALESCE(MAX(rowid), 0) FROM meter_events) - ?
            AND status = 'succeeded' AND duration_ms > 0 AND created_at >= ?
            AND kind IN ('video', 'image', 'audio')`,
    args: [METER_WINDOW, at - HISTORY_MS],
  });
  const samples = samplesByModel((rs.rows as unknown as { model: unknown; duration_ms: unknown }[])
    .map((r) => ({ model: String(r.model ?? ""), ms: Number(r.duration_ms) })));
  platformMemo = { at, samples };
  return samples;
}

async function workspaceSamples(at: number): Promise<Map<string, number[]>> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT model, duration_ms FROM generations
          WHERE created_at >= ? AND status = 'succeeded' AND deleted = 0 AND duration_ms > 0
          ORDER BY created_at DESC LIMIT ?`,
    args: [at - HISTORY_MS, WORKSPACE_LIMIT],
  });
  return samplesByModel((rs.rows as unknown as { model: unknown; duration_ms: unknown }[])
    .map((r) => ({ model: String(r.model ?? ""), ms: Number(r.duration_ms) })));
}

/** The reply for the workspace in scope. */
export async function typicalTimes(at = Date.now()): Promise<TypicalTimesReply> {
  const hit = ttl() > 0 ? cached<TypicalTimesReply>(KEY, ttl()) : null;
  if (hit) return hit;
  const [platform, workspace] = await Promise.all([
    platformSamples(at).catch((error: unknown) => { console.error("typical times (platform):", (error as Error).message); return new Map<string, number[]>(); }),
    workspaceSamples(at).catch((error: unknown) => { console.error("typical times (workspace):", (error as Error).message); return new Map<string, number[]>(); }),
  ]);
  const reply: TypicalTimesReply = { models: typicalTable(platform, workspace) };
  putCache(KEY, reply);
  return reply;
}
