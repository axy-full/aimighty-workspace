import type { Client } from "@libsql/client";

type Reader = Pick<Client, "execute">;
export const CONSUMER_ORIGINAL_PENDING_MESSAGE =
  "This original is still being finalized. Check the saved Higgsfield job before deleting it.";

// Both records are server-written. Generation params alone cannot retain an
// unrelated file. Keep the original between its storage commit and the separate
// consumer completion commit, including after the collecting request crashes.
const pendingOriginalIds = `SELECT g.id FROM consumer_video_originals o
  JOIN higgsfield_consumer_jobs j ON j.id=o.job_id AND j.user_id=o.owner_id
    AND j.draft_id=o.draft_id AND j.provider_job_id=o.provider_job_id
  JOIN generations g ON g.id=o.generation_id AND g.created_by=o.owner_id
  WHERE j.status='accepted' AND j.workflow='marketing-video' AND j.dispatch_claim_hash IS NOT NULL
    AND o.state='stored' AND o.receipt_json IS NOT NULL AND o.sha256 IS NOT NULL
    AND g.status='succeeded' AND g.provider='higgsfield' AND g.model='marketing_studio_video' AND g.kind='video'
    AND g.stored_url IS NOT NULL AND g.bytes=o.bytes
    AND json_extract(CASE WHEN json_valid(g.params) THEN g.params ELSE '{}' END,'$.consumerJobId')=o.job_id
    AND json_extract(CASE WHEN json_valid(g.params) THEN g.params ELSE '{}' END,'$.consumerProviderJobId')=o.provider_job_id
    AND json_extract(CASE WHEN json_valid(g.params) THEN g.params ELSE '{}' END,'$.originalSha256')=o.sha256`;

/** Read on the caller's tenant transaction; older databases need no migration. */
export async function consumerOriginalRetentionQuery(
  reader: Reader,
): Promise<string | null> {
  const tables = await reader.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('consumer_video_originals','higgsfield_consumer_jobs')",
  );
  return tables.rows.length === 2 ? pendingOriginalIds : null;
}

export async function consumerOriginalPending(
  reader: Reader,
  generationId?: string,
): Promise<boolean> {
  const query = await consumerOriginalRetentionQuery(reader);
  return (
    !!query &&
    (
      await reader.execute({
        sql: `${query} AND (? IS NULL OR g.id=?) LIMIT 1`,
        args: [generationId ?? null, generationId ?? null],
      })
    ).rows.length > 0
  );
}
