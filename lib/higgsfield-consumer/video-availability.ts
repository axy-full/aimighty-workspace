import { db } from "../db";
import { requireTenant } from "../tenant";
import { uploadReservationsReady } from "../uploadReservations";
import type { ConsumerJob, ConsumerJson } from "./jobs";
import { consumerOriginalGenerationId } from "./video-original";
import { consumerVideoIdentity } from "./original-identity";

export type ConsumerOriginalAvailability =
  "available" | "deleted" | "unavailable" | "not_collected";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function jsonRecord(value: unknown) {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Tenant-local metadata check, independent of the immutable completion receipt.
 * Batch the list to avoid one database round trip per historical video. */
export async function consumerOriginalAvailability(
  jobs: readonly ConsumerJob[],
) {
  if (jobs.length > 50)
    throw new Error("Consumer original lookup exceeds its bound.");
  const states = new Map<string, ConsumerOriginalAvailability>(
    jobs.map((job) => [
      job.id,
      job.status === "completed" ? "unavailable" : "not_collected",
    ]),
  );
  const completed = jobs.filter(
    (job) => job.status === "completed" && record(job.resultManifest?.original),
  );
  if (!completed.length) return states;
  await uploadReservationsReady();
  const rows = (
    await db().execute({
      sql: `SELECT o.*,g.deleted AS gen_deleted,g.id AS gen_id,g.created_by AS gen_owner,g.provider AS gen_provider,
      g.model AS gen_model,g.kind AS gen_kind,g.status AS gen_status,g.stored_url AS gen_url,g.bytes AS gen_bytes,g.params AS gen_params
      FROM consumer_video_originals o LEFT JOIN generations g ON g.id=o.generation_id
      WHERE o.job_id IN (${completed.map(() => "?").join(",")})`,
      args: completed.map((job) => job.id),
    })
  ).rows;
  const byId = new Map(rows.map((row) => [String(row.job_id), row]));
  for (const job of completed) {
    let model: string, kind: string;
    try { ({ model, kind } = consumerVideoIdentity(job)); } catch { continue; }
    const original = job.resultManifest!.original as Record<
        string,
        ConsumerJson
      >,
      row = byId.get(job.id);
    const generationId = consumerOriginalGenerationId(
      requireTenant().id,
      job.id,
    );
    if (
      !row ||
      row.state !== "stored" ||
      row.owner_id !== job.userId ||
      row.draft_id !== job.draftId ||
      row.provider_job_id !== job.providerJobId ||
      row.generation_id !== generationId ||
      original.generationId !== generationId ||
      original.providerJobId !== job.providerJobId ||
      original.creditUnit !== "higgsfield_credits" ||
      original.credits !== job.quoteCredits ||
      original.sha256 !== row.sha256 ||
      typeof original.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(original.sha256) ||
      original.bytes !== Number(row.bytes) ||
      Number(row.bytes) <= 0
    )
      continue;
    const saved = jsonRecord(row.receipt_json),
      params = jsonRecord(row.gen_params);
    if (!saved || !record(original.asset) || !record(saved.asset)) continue;
    const savedAsset = saved.asset,
      originalAsset = original.asset;
    const sameKeys = (left: Record<string, unknown>, right: Record<string, unknown>) =>
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((key) => key === "asset" ? true : left[key] === right[key]);
    if (
      !sameKeys(saved, original) ||
      !sameKeys(savedAsset, originalAsset) ||
      originalAsset.url !== `/api/media/${generationId}` ||
      originalAsset.generationId !== generationId ||
      row.gen_id !== generationId ||
      row.gen_owner !== job.userId ||
      row.gen_provider !== "higgsfield" ||
      row.gen_model !== model ||
      row.gen_kind !== kind ||
      row.gen_status !== "succeeded" ||
      params?.consumerJobId !== job.id ||
      params.consumerProviderJobId !== job.providerJobId ||
      params.originalSha256 !== original.sha256
    )
      continue;
    if (Number(row.gen_deleted)) states.set(job.id, "deleted");
    else if (
      typeof row.gen_url === "string" &&
      row.gen_url.length > 0 &&
      Number(row.gen_bytes) === original.bytes
    )
      states.set(job.id, "available");
  }
  return states;
}
