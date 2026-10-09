/**
 * What only the server can tell about a take in flight, read off its stored
 * row (generations) before lib/jobs rowToGeneration strips the internals, as
 * plain facts the render-state model (lib/v12/renderState.ts) can take to the
 * browser. Nothing here is an id, a handle, a lease or a figure.
 *
 * - `atProvider`: the provider has accepted it. The same receipts
 *   lib/submitVideo.ts knownTask reads: an Ark task id, a fal request id, an
 *   API-key video handle (with its paid claim), or a still's request id.
 * - `saving`: its result is being moved into storage now. A video polled by
 *   lib/jobs.ts holds a store lease (`storeUntil`) while it downloads; an
 *   API-key video has collected its original (`genjutsuOriginal`) and is
 *   storing it. Any other path stores inside one step and is never "Saving".
 * - `discarded`: cancelled by discarding it while held.
 *
 * Pure.
 */
export type RenderFacts = { atProvider: boolean; saving: boolean; discarded: boolean };

export type RawRenderRow = {
  status: string;
  created_at: number | string | bigint;
  ark_task_id?: string | null;
  params?: string | Record<string, unknown> | null;
};

const text = (v: unknown) => typeof v === "string" && v.length > 0;

export function renderFactsFromRow(row: RawRenderRow, now: number): RenderFacts {
  let params: Record<string, unknown> = {};
  if (typeof row.params === "string") {
    try { params = JSON.parse(row.params || "{}") as Record<string, unknown>; } catch { params = {}; }
  } else if (row.params && typeof row.params === "object") params = row.params;
  const handle = params.higgsfieldVideoHandle as { ref?: unknown } | undefined;
  const stillHandle = params.higgsfieldStillHandle as { ref?: unknown } | undefined;
  const atProvider = text(row.ark_task_id) || text(params.falRequestId) || text(params.falStillRequestId)
    || (text(handle?.ref) && params.paidClaim != null) || text(stillHandle?.ref);
  const lease = Number(params.storeUntil);
  const saving = row.status === "running" && ((Number.isFinite(lease) && lease > now) || (params.genjutsuOriginal != null && typeof params.genjutsuOriginal === "object"));
  return {
    atProvider: Boolean(atProvider),
    saving,
    discarded: row.status === "cancelled" && params.discardedAt != null,
  };
}
