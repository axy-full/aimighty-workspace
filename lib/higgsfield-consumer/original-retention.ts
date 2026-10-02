import type { Client } from "@libsql/client";

type Reader = Pick<Client, "execute">;

/**
 * Collected account originals whose ledger never recorded completion: the old
 * collector stored the bytes and filed the take, then its separate completion
 * commit never ran (the request crashed, or the job was still open when the
 * account was disconnected). Particl no longer signs in to Higgsfield
 * (CLAUDE.md ground rule 10), so nothing will finish one. A person deletes such
 * a take like any other (lib/mediaDeletion.ts); purge reads this to record the
 * disposal on the job's own row before a deleted workspace is removed
 * (lib/purge.ts). Both records are server-written: generation params alone
 * cannot match an unrelated file.
 */
const pendingOriginalIds = `SELECT g.id FROM consumer_video_originals o
  JOIN higgsfield_consumer_jobs j ON j.id=o.job_id AND j.user_id=o.owner_id
    AND j.draft_id=o.draft_id AND j.provider_job_id=o.provider_job_id
  JOIN generations g ON g.id=o.generation_id AND g.created_by=o.owner_id
  WHERE j.status='accepted' AND j.dispatch_claim_hash IS NOT NULL
    AND ((j.workflow='marketing-video' AND g.model='marketing_studio_video') OR
      (j.workflow='genjutsu' AND g.model IN ('hf_mult_motion_control','hf_mult_replace_object')
        AND g.model=json_extract(CASE WHEN json_valid(j.payload_json) THEN j.payload_json ELSE '{}' END,'$.params.model')) OR
      (j.workflow='generation'
        AND g.model=json_extract(CASE WHEN json_valid(j.payload_json) THEN j.payload_json ELSE '{}' END,'$.params.model')))
    AND o.state='stored' AND o.receipt_json IS NOT NULL AND o.sha256 IS NOT NULL
    AND g.status='succeeded' AND g.provider='higgsfield' AND g.kind IN ('video','image','audio','model')
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
