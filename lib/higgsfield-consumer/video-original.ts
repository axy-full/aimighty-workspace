import { db } from "../db";
import { uploadReservationsReady } from "../uploadReservations";

/**
 * The account originals the Library still holds. Particl no longer signs in to
 * Higgsfield (CLAUDE.md ground rule 10), so nothing collects one any more; the
 * ones collected earlier stay ordinary Library takes, each proven by its
 * server-written receipt (consumer_video_originals). Reads only. The MP4
 * inspection the API-key collector uses lives in lib/videoOriginal.ts.
 */

/** Uses a server-written receipt, not merely user-controllable generation params. */
export const RETAINED_CONSUMER_ORIGINAL_SQL = `g.status='succeeded' AND g.provider='higgsfield' AND (g.model IN ('marketing_studio_video','hf_mult_motion_control','hf_mult_replace_object') OR json_extract(g.params,'$.task')='connected-generation') AND g.kind IN ('video','image','audio','model') AND g.stored_url IS NOT NULL
  AND json_extract(g.params,'$.consumerCreditUnit')='higgsfield_credits'
  AND EXISTS(SELECT 1 FROM consumer_video_originals o WHERE o.generation_id=g.id AND o.state='stored' AND o.receipt_json IS NOT NULL
    AND o.owner_id=g.created_by AND o.bytes=g.bytes AND o.job_id=json_extract(g.params,'$.consumerJobId')
    AND o.provider_job_id=json_extract(g.params,'$.consumerProviderJobId') AND o.sha256=json_extract(g.params,'$.originalSha256'))`;
export async function hasRetainedConsumerOriginal(generationId: string) {
  await uploadReservationsReady();
  return (
    (
      await db().execute({
        sql: `SELECT 1 FROM generations g WHERE g.id=? AND (${RETAINED_CONSUMER_ORIGINAL_SQL})`,
        args: [generationId],
      })
    ).rows.length > 0
  );
}
