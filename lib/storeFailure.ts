import { db, now } from "./db";

/**
 * A master the provider finished that our storage did not take.
 *
 * The take keeps playing from the provider's own link, which expires, and the
 * cron keeps trying to save it (lib/jobs.ts syncPending, lib/falVideo.ts). The
 * failure is noted on the take itself so the platform owner's alert
 * (lib/rendersAtRisk.ts) can say when saving first failed and what the last
 * attempt said. Only a redacted, bounded copy of the error is kept: no link,
 * query string or bearer token from a provider or storage message.
 */
export const STORE_FAILED_AT = "$.storeFailedAt";
export const STORE_ERROR = "$.storeError";

export function storeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
    .replace(/\b(?:sig|signature|token|key|x-amz-[a-z-]+)=[^\s&]+/gi, "[hidden]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Best effort: a note that cannot be written never changes how the save failure is handled. */
export async function noteStoreFailure(id: string, error: unknown, at = now()): Promise<void> {
  try {
    await db().execute({
      sql: `UPDATE generations
              SET params=json_set(params,'${STORE_FAILED_AT}',COALESCE(json_extract(params,'${STORE_FAILED_AT}'),?),'${STORE_ERROR}',?)
            WHERE id=? AND stored_url IS NULL`,
      args: [at, storeErrorText(error), id],
    });
  } catch {
    console.error(JSON.stringify({ level: "warn", event: "renders.store_failure_note", outcome: "not_written" }));
  }
}
