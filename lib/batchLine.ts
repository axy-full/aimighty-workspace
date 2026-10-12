import { db } from "./db";
import { platformDb, platformReady } from "./platform";
import { requireTenant } from "./tenant";
import { isBatchId } from "./variations";

/**
 * Guardrail 4 counts one press as one job. A press of 2–4 takes is N requests that carry the same batch id and the press's size (`batchSize`);
 * the line (lib/approvalRule.ts › jobLineVerdict) is judged on the sum of the batch's takes, each at its hold: the takes already reserved
 * under this id plus this one and the ones still to come. So the first take of 4 × 60 cr is told an admin must start it, and nothing is reserved for
 * any take. The id and the size come from the person's own press (the composer sends both); the server counts what it has reserved under that id, and
 * a request that names no batch is one job.
 */
export type BatchRef = { id: string; size: number };
/** What the batch already holds in this workspace: takes reserved or waiting, in credits at their hold and in the engines' dollars at theirs. */
export type BatchTally = { count: number; credits: number; usd: number };
export const NO_BATCH: BatchTally = { count: 0, credits: 0, usd: 0 };

/** A batch's size as a press states it: a whole number from 2 to 8 (the largest strip). Anything else is no batch. */
export function batchRefOf(body: { batchId?: unknown; batchSize?: unknown }): BatchRef | undefined {
  if (!isBatchId(body.batchId)) return undefined;
  const size = Number(body.batchSize);
  return { id: body.batchId, size: Number.isInteger(size) && size >= 2 && size <= 8 ? size : 1 };
}

/** The takes of a batch still in play (not failed, not deleted) in the current workspace, apart from `except` (the take being judged). */
export async function batchTally(ref: BatchRef | undefined, except?: string): Promise<BatchTally> {
  if (!ref) return NO_BATCH;
  const ws = requireTenant();
  const takes = (await db().execute({
    sql: `SELECT id,status,json_extract(params,'$.held.needs') AS held_needs,json_extract(params,'$.held.estUsd') AS held_usd FROM generations
          WHERE json_extract(params,'$.batchId')=? AND deleted=0 AND status NOT IN ('failed','cancelled','canceled')`,
    args: [ref.id],
  })).rows.filter((r) => String(r.id) !== except);
  if (!takes.length) return NO_BATCH;
  await platformReady();
  const metered = new Map<string, { credits: number; usd: number }>();
  for (const r of (await platformDb().execute({
    sql: `SELECT id,billed_credits,engine_cost_usd,hold_band FROM meter_events WHERE workspace_id=? AND status<>'failed' AND id IN (${takes.map(() => "?").join(",")})`,
    args: [ws.id, ...takes.map((t) => String(t.id))],
  })).rows) metered.set(String(r.id), { credits: Number(r.billed_credits ?? 0), usd: Number(r.engine_cost_usd ?? 0) * Math.max(1, Number(r.hold_band ?? 1)) });
  const tally = { count: 0, credits: 0, usd: 0 };
  for (const t of takes) {
    const m = metered.get(String(t.id));
    /* A take waiting held has no meter row yet: it counts at what its hold says it needs. */
    const own = m ?? (t.status === "held" ? { credits: Number(t.held_needs ?? 0), usd: Number(t.held_usd ?? 0) } : null);
    if (!own) continue;
    tally.count += 1; tally.credits += own.credits; tally.usd += own.usd;
  }
  return tally;
}

/** How many takes of the press are still to be judged with this one: its declared size less the takes already counted, at least this one. */
export const takesToCome = (ref: BatchRef | undefined, tally: BatchTally): number => Math.max(1, (ref?.size ?? 1) - tally.count);
