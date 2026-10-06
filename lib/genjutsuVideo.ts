import { withAcceptedJobCredentials } from "./acceptedJobCredentials";
import { createHash, randomUUID } from "node:crypto";
import { db, now, ready } from "./db";
import { engineFor } from "./engines";
import type { RenderHandle } from "./engines/types";
import { isGenjutsuModel } from "./genjutsuTypes";
import { CINEMA_STUDIO_MODEL_ID, isCinemaStudioModel, isHiggsfieldVideoModel } from "./cinemaStudioTypes";
import { cinemaStudioDeliveredUsd, cinemaStudioSettlement } from "./cinemaStudio";
import { restoreHiggsfieldGenerationReceipt, settleHiggsfieldGenerationReceipt } from "./higgsfieldGenerationReceipts";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { HiggsfieldHttpError, HiggsfieldKeyChangedError } from "./higgsfield";
import { clearKeyChanged, markKeyChanged } from "./higgsfieldKeyAlerts";
import { currentTenant, requireTenant } from "./tenant";
import { withRecoveryJob } from "./recovery";
import { workbenchTransaction } from "./workbench/records";
import { fetchPublicConsumerVideoBytes } from "./workbench/product-fetch";
import { inspectConsumerVideoOriginal } from "./higgsfield-consumer/video-original";
import { storeVideoBytes, readVideoBytesLimited } from "./storage";
import { quotaVerdict, workspaceLimits } from "./limits";
import { uploadReservationsReady } from "./uploadReservations";
import { engineMock, fixtureUrl } from "./mock";
import { fixtureBytes } from "./mockFs";
import { invalidate, PROJECTS_KEY } from "./cache";
import { fundedOutcome } from "./providerFailure";
import { higgsfieldRequestOutcome, noAnswerOutcome, serializeOutcome } from "./providerOutcome";

type Original = { bytes: number; sha256: string; width: number; height: number; seconds: number; requestId: string };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const safeFailure = (model: string) => `The accepted ${isGenjutsuModel(model) ? "transform " : ""}original could not be collected yet. Its request and reserved cost are retained; check again after storage and the original connection are available.`;

/** A separate lease protects collection, never paid dispatch. Bytes are reserved
 * on the existing generation before storage I/O, so crash uncertainty remains
 * included in all existing quota and workspace storage inventories. Collects
 * every Higgsfield video on the commercial key (Genjutsu transforms and
 * Cinema Studio); the original's receipt keeps its `genjutsuOriginal` name. */
export async function reconcileGenjutsuVideo(id: string): Promise<void> {
  return withRecoveryJob(requireTenant().id, id, async () => {
    await ready();
    await restoreHiggsfieldGenerationReceipt(id);
    await deliverGenerationSettlement(id);
    const token = randomUUID(), until = now() + 180_000;
    const claim = await db().execute({ sql: `UPDATE generations SET params=json_set(params,'$.higgsfieldVideoPollUntil',?,'$.higgsfieldVideoPollToken',?)
      WHERE id=? AND kind='video' AND provider='higgsfield' AND deleted=0 AND status IN ('queued','running')
      AND json_extract(params,'$.higgsfieldVideoHandle') IS NOT NULL AND COALESCE(json_extract(params,'$.higgsfieldVideoPollUntil'),0) < ? RETURNING *`,
      args: [until, token, id, now()] });
    if (!claim.rows.length) { await settleHiggsfieldGenerationReceipt(id); return; }
    const row = claim.rows[0], params = JSON.parse(String(row.params));
    try {
      const handle = params.higgsfieldVideoHandle as RenderHandle, usd = params.higgsfieldVendorCostUsd;
      if (!isHiggsfieldVideoModel(String(row.model)) || !params.paidClaim || handle.provider !== "higgsfield" || handle.model !== row.model ||
          !handle.credentialFingerprint || handle.credentialFingerprint !== params.higgsfieldCredentialFingerprint || !Number.isFinite(usd) || usd <= 0)
        throw new Error("Invalid admission");
      let original = params.genjutsuOriginal as Original | undefined;
      let stored: Awaited<ReturnType<typeof storeVideoBytes>> | undefined;
      let reportedUsd: number | null = null;
      if (original) {
        if (original.requestId !== handle.ref || !/^[a-f0-9]{64}$/.test(original.sha256) || !Number.isSafeInteger(original.bytes) || original.bytes <= 0 || original.bytes > 100 * 1024 * 1024)
          throw new Error("Invalid original receipt");
        const retained = await readVideoBytesLimited(id, original.bytes);
        if (retained) {
          if (retained.length !== original.bytes || hash(retained) !== original.sha256) throw new Error("Original changed");
          stored = { url: `/api/media/${id}`, bytes: original.bytes, sha256: original.sha256 };
        }
      }
      if (!stored) {
        const state = await withAcceptedJobCredentials(id, "higgsfield", () => engineFor("higgsfield").poll!(handle));
        /* The key it was sent on answered: any wait for a changed key is over. */
        if (params.providerKeyChanged != null) await clearKeyChanged(id);
        if (state.status === "failed" || state.status === "cancelled") {
          if (original) throw new Error("Contradictory provider outcome");
          /* Its own status and words; its FAQ says failed and NSFW requests are refunded, and only completions billed. */
          const said = await fundedOutcome(higgsfieldRequestOutcome(state.raw), id, "higgsfield").catch(() => null);
          /* A failed Cinema Studio take is charged what its provider reported for it, never past its quote (N), and nothing
             when it reported nothing (owner's decision, 6 October 2026; the meter caps it, lib/meter.ts heldSettlement). */
          const failedUsd = isCinemaStudioModel(String(row.model)) && typeof state.costUsd === "number" && Number.isFinite(state.costUsd) && state.costUsd > 0
            ? state.costUsd : 0;
          await writeGenerationOutcome({ sql: `UPDATE generations SET status=?,cost_usd=?,error=?,provider_outcome=COALESCE(?,provider_outcome),updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=?`,
            args: [state.status, Math.min(failedUsd, usd), state.error || (isGenjutsuModel(String(row.model)) ? "The connected account canceled this transform request." : "The connected account canceled this request."), said ? serializeOutcome(said) : null, now(), id, token] },
            { id, kind: "video", model: String(row.model), engine: "higgsfield", status: "failed", engineCostUsd: failedUsd, projectId: row.project_id == null ? null : String(row.project_id), createdBy: row.created_by == null ? undefined : String(row.created_by), providerOutcome: said });
          await deliverGenerationSettlement(id);
          await settleHiggsfieldGenerationReceipt(id);
          return;
        }
        if (state.status !== "succeeded") {
          await db().execute({ sql: "UPDATE generations SET status=?,error=NULL,updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=?", args: [state.status, now(), id, token] });
          return;
        }
        if (!state.videoUrl) throw new Error("No original");
        reportedUsd = typeof state.costUsd === "number" ? state.costUsd : null;
        const bytes = engineMock() && state.videoUrl === fixtureUrl("clip.mp4") ? await fixtureBytes("clip.mp4") : (await fetchPublicConsumerVideoBytes(state.videoUrl)).bytes;
        const metadata = await inspectConsumerVideoOriginal(bytes);
        const candidate: Original = { ...metadata, bytes: bytes.length, sha256: hash(bytes), requestId: handle.ref };
        if (original && (candidate.bytes !== original.bytes || candidate.sha256 !== original.sha256)) throw new Error("Original changed");
        original = candidate;
        await uploadReservationsReady();
        const quota = (await workspaceLimits()).storageBytes;
        await workbenchTransaction(async tx => {
          const current = (await tx.execute({ sql: "SELECT params,bytes,status,deleted FROM generations WHERE id=?", args: [id] })).rows[0];
          if (!current || current.deleted || !["queued", "running"].includes(String(current.status))) throw new Error("Take unavailable");
          const fresh = JSON.parse(String(current.params));
          if (fresh.higgsfieldVideoPollToken !== token || fresh.higgsfieldVideoPollUntil <= now() || fresh.higgsfieldVideoHandle?.ref !== handle.ref) throw new Error("Collection lease changed");
          if (fresh.genjutsuOriginal && (fresh.genjutsuOriginal.sha256 !== original!.sha256 || fresh.genjutsuOriginal.bytes !== original!.bytes)) throw new Error("Original changed");
          const used = Number((await tx.execute(`SELECT (SELECT COALESCE(SUM(bytes),0) FROM generations WHERE deleted=0) +
            (SELECT COALESCE(SUM(COALESCE(bytes,0)+COALESCE(derivative_bytes,0)),0) FROM uploads) +
            (SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_sessions) +
            (SELECT COALESCE(SUM(bytes),0) FROM consumer_video_originals WHERE state <> 'stored') AS n`)).rows[0].n);
          if (!quotaVerdict({ usedBytes: used, incomingBytes: Math.max(0, bytes.length - Number(current.bytes || 0)), quotaBytes: quota }).allow) throw new HiggsfieldHttpError(507, "Workspace storage is full. The transform original remains available for collection; free storage and retry status.");
          await tx.execute({ sql: "UPDATE generations SET bytes=?,params=json_set(params,'$.genjutsuOriginal',json(?)),updated_at=? WHERE id=?", args: [bytes.length, JSON.stringify(original), now(), id] });
        });
        stored = await storeVideoBytes(id, bytes);
      }
      if (!original) throw new Error("Missing original receipt");
      // duration_s is the column the per-second tools price from. A transform
      // follows its source's shape, so its params carry the measured length and
      // ratio; Cinema Studio keeps the duration and aspect it was asked for (and
      // priced at), like every other generated take.
      const transform = isGenjutsuModel(String(row.model));
      const keptDuration = transform ? original.seconds : Number(params.duration);
      const keptRatio = transform ? `${original.width}:${original.height}` : String(params.ratio);
      // A transform settles at its live estimate. Cinema Studio was quoted
      // approximately and settles on what was delivered: the provider's own
      // charge if it states one, else its published formula on the measured
      // output (with what sound adds, for a take made with sound), never past
      // the hold a person approved (lib/cinemaHold.ts). A take the engine
      // charged more for is kept and shown, charged the hold, and marked; what
      // passed the hold is the platform's, and only its admin desk sees it.
      const settlement = isCinemaStudioModel(String(row.model))
        ? cinemaStudioSettlement(usd, cinemaStudioDeliveredUsd({
            resolution: String(params.resolution), width: original.width, height: original.height, seconds: original.seconds,
            hasVideoInput: Boolean(params.hasVideoInput), inputSeconds: Number(params.inputSeconds),
            generateAudio: params.generateAudio === true,
          }), reportedUsd)
        : { usd, overrunUsd: null };
      const settledUsd = settlement.usd;
      /* The mark is words only, never a figure: the take's own record reaches its workspace. */
      const overHold = settlement.overrunUsd != null;
      await writeGenerationOutcome({ sql: `UPDATE generations SET status='succeeded',stored_url=?,source_url=NULL,bytes=?,cost_usd=?,error=NULL,duration_s=?,
        params=json_set(params,'$.duration',?,'$.width',?,'$.height',?,'$.ratio',?${overHold ? ",'$.overHold',json('true')" : ""}),updated_at=?
        WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=? AND json_extract(params,'$.higgsfieldVideoPollUntil')>?`,
        args: [stored.url,stored.bytes,settledUsd,Math.round(original.seconds * 1000) / 1000,keptDuration,original.width,original.height,keptRatio,now(),id,token,now()] },
        { id, kind: "video", model: String(row.model), engine: "higgsfield", status: "succeeded", engineCostUsd: settledUsd,
          ...(overHold ? { overrunUsd: settlement.overrunUsd } : {}),
          projectId: row.project_id == null ? null : String(row.project_id), shotId: row.shot_id == null ? null : String(row.shot_id), createdBy: row.created_by == null ? undefined : String(row.created_by) });
      await deliverGenerationSettlement(id);
      await settleHiggsfieldGenerationReceipt(id);
      invalidate(PROJECTS_KEY);
    } catch (error) {
      /* The key this request was sent on is gone: nothing was asked. It waits, visibly, and the platform's admin is told. */
      if (error instanceof HiggsfieldKeyChangedError) {
        await markKeyChanged(id, (params.higgsfieldVideoHandle as RenderHandle | undefined)?.credentialFingerprint);
        return;
      }
      const message = error instanceof HiggsfieldHttpError && error.status === 507 ? error.message : safeFailure(String(row.model));
      await db().execute({ sql: "UPDATE generations SET error=?,updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=?", args: [message, now(), id, token] });
      throw new Error(message);
    } finally {
      await db().execute({ sql: "UPDATE generations SET params=json_remove(params,'$.higgsfieldVideoPollUntil','$.higgsfieldVideoPollToken') WHERE id=? AND json_extract(params,'$.higgsfieldVideoPollToken')=?", args: [id, token] });
    }
  });
}

/** Cancellation is a separate explicit action. A 202 acknowledgement is not a
 * terminal outcome or refund; the normal collector confirms that via status. */
export async function cancelGenjutsuVideo(id: string): Promise<{status: "requested" | "running" | "succeeded" | "failed" | "cancelled"}> {
  return withRecoveryJob(requireTenant().id, id, async () => {
    await ready();
    const row = (await db().execute({sql: "SELECT model,provider,kind,status,created_by,params FROM generations WHERE id=? AND deleted=0",args:[id]})).rows[0];
    if (!row || !isHiggsfieldVideoModel(String(row.model)) || row.provider !== "higgsfield" || row.kind !== "video") throw new HiggsfieldHttpError(404,"No such transform request.");
    const user = currentTenant()?.user;
    if (!user || (user.role !== "admin" && row.created_by !== user.id)) throw new HiggsfieldHttpError(403,"Only the creator or a workspace administrator can cancel this request.");
    if (["succeeded","failed","cancelled"].includes(String(row.status))) return {status: row.status as "succeeded" | "failed" | "cancelled"};
    const params = JSON.parse(String(row.params));
    const handle = params.higgsfieldVideoHandle as RenderHandle | undefined;
    if (!handle || handle.model !== row.model || handle.credentialFingerprint !== params.higgsfieldCredentialFingerprint || !params.paidClaim)
      throw new HiggsfieldHttpError(409,"The provider acknowledgement is not available yet. Refresh status before cancelling.");
    const engine = engineFor("higgsfield");
    const state = await withAcceptedJobCredentials(id, "higgsfield", () => engine.poll!(handle));
    if (state.status !== "queued") {
      if (state.status !== "running") await reconcileGenjutsuVideo(id);
      return {status: state.status};
    }
    try { await withAcceptedJobCredentials(id, "higgsfield", () => engine.cancel!(handle)); }
    catch (error) {
      if (error instanceof HiggsfieldHttpError) throw error;
      throw new HiggsfieldHttpError(503,"Cancellation could not be confirmed. The request remains tracked; refresh status before trying again.");
    }
    return {status:"requested"};
  });
}

/** How long a Cinema Studio take may wait for its provider's answer before its hold is released (owner, 6 October 2026). */
export const CINEMA_ANSWER_LIMIT_MS = 24 * 3_600_000;
export const CINEMA_UNANSWERED = "No answer from the engine after 24 hours. Nothing was charged, and the credits it held are back.";

/**
 * The time limit on a Cinema Studio take's hold: a take that has had no answer from its provider for 24 hours since it
 * was sent (`created_at`, restarted when a held take is released) ends as failed, charged nothing, its hold released at
 * once, and recorded for the platform admin desk (its failed takes card reads the outcome). One take at a time, under
 * the same recovery job as its collector, and only while no collection holds its lease, so a take whose answer is
 * arriving right now is never cut off. Nothing is sent to the provider. The cron sync runs it (app/api/cron/sync).
 */
export async function expireUnansweredCinemaTakes(options: { limit?: number; deadlineAt?: number; at?: number } = {}): Promise<{ expired: string[] }> {
  await ready();
  const at = options.at ?? now();
  const rows = (await db().execute({
    sql: `SELECT id, model, project_id, shot_id, created_by FROM generations
          WHERE deleted=0 AND kind='video' AND provider='higgsfield' AND model=? AND status IN ('queued','running') AND created_at <= ?
            AND COALESCE(json_extract(params,'$.higgsfieldVideoPollUntil'),0) < ?
          ORDER BY created_at, id LIMIT ?`,
    args: [CINEMA_STUDIO_MODEL_ID, at - CINEMA_ANSWER_LIMIT_MS, at, Math.max(1, Math.min(20, options.limit ?? 5))],
  })).rows;
  const expired: string[] = [];
  for (const row of rows) {
    if (options.deadlineAt != null && Date.now() >= options.deadlineAt) break;
    const id = String(row.id);
    const ended = await withRecoveryJob(requireTenant().id, id, async () => {
      const said = noAnswerOutcome("higgsfield", "run", CINEMA_UNANSWERED);
      const written = await writeGenerationOutcome({
        sql: `UPDATE generations SET status='failed',cost_usd=0,error=?,provider_outcome=COALESCE(provider_outcome,?),updated_at=?
              WHERE id=? AND deleted=0 AND status IN ('queued','running') AND created_at <= ? AND COALESCE(json_extract(params,'$.higgsfieldVideoPollUntil'),0) < ?`,
        args: [CINEMA_UNANSWERED, serializeOutcome(said), now(), id, at - CINEMA_ANSWER_LIMIT_MS, now()],
      }, { id, kind: "video", model: String(row.model), engine: "higgsfield", status: "failed", engineCostUsd: 0, providerOutcome: said,
        projectId: row.project_id == null ? null : String(row.project_id), shotId: row.shot_id == null ? null : String(row.shot_id),
        createdBy: row.created_by == null ? undefined : String(row.created_by) });
      if (!written) return false;
      await deliverGenerationSettlement(id);
      await settleHiggsfieldGenerationReceipt(id).catch(() => {});
      return true;
    });
    if (ended) expired.push(id);
  }
  if (expired.length) invalidate(PROJECTS_KEY);
  return { expired };
}
