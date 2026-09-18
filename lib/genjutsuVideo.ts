import { createHash, randomUUID } from "node:crypto";
import { db, now, ready } from "./db";
import { engineFor } from "./engines";
import type { RenderHandle } from "./engines/types";
import { isGenjutsuModel } from "./genjutsuTypes";
import { restoreHiggsfieldGenerationReceipt, settleHiggsfieldGenerationReceipt } from "./higgsfieldGenerationReceipts";
import { writeGenerationOutcome, deliverGenerationSettlement } from "./generationSettlement";
import { HiggsfieldHttpError } from "./higgsfield";
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

type Original = { bytes: number; sha256: string; width: number; height: number; seconds: number; requestId: string };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const safeFailure = "The accepted Genjutsu original could not be collected yet. Its request and reserved cost are retained; check again after storage and the original connection are available.";

/** A separate lease protects collection, never paid dispatch. Bytes are reserved
 * on the existing generation before storage I/O, so crash uncertainty remains
 * included in all existing quota and workspace storage inventories. */
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
      if (!isGenjutsuModel(String(row.model)) || !params.paidClaim || handle.provider !== "higgsfield" || handle.model !== row.model ||
          !handle.credentialFingerprint || handle.credentialFingerprint !== params.higgsfieldCredentialFingerprint || !Number.isFinite(usd) || usd <= 0)
        throw new Error("Invalid admission");
      let original = params.genjutsuOriginal as Original | undefined;
      let stored: Awaited<ReturnType<typeof storeVideoBytes>> | undefined;
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
        const state = await engineFor("higgsfield").poll!(handle);
        if (state.status === "failed" || state.status === "cancelled") {
          if (original) throw new Error("Contradictory provider outcome");
          await writeGenerationOutcome({ sql: `UPDATE generations SET status=?,cost_usd=0,error=?,updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=?`,
            args: [state.status, state.error || "Higgsfield canceled this Genjutsu request.", now(), id, token] },
            { id, kind: "video", model: String(row.model), engine: "higgsfield", status: "failed", engineCostUsd: 0, projectId: row.project_id == null ? null : String(row.project_id), createdBy: row.created_by == null ? undefined : String(row.created_by) });
          await deliverGenerationSettlement(id);
          await settleHiggsfieldGenerationReceipt(id);
          return;
        }
        if (state.status !== "succeeded") {
          await db().execute({ sql: "UPDATE generations SET status=?,error=NULL,updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=?", args: [state.status, now(), id, token] });
          return;
        }
        if (!state.videoUrl) throw new Error("No original");
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
          const used = Number((await tx.execute(`SELECT (SELECT COALESCE(SUM(bytes),0) FROM generations) +
            (SELECT COALESCE(SUM(COALESCE(bytes,0)+COALESCE(derivative_bytes,0)),0) FROM uploads) +
            (SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_sessions) +
            (SELECT COALESCE(SUM(bytes),0) FROM consumer_video_originals WHERE state <> 'stored') AS n`)).rows[0].n);
          if (!quotaVerdict({ usedBytes: used, incomingBytes: Math.max(0, bytes.length - Number(current.bytes || 0)), quotaBytes: quota }).allow) throw new HiggsfieldHttpError(507, "Workspace storage is full. The Genjutsu original remains available for collection; free storage and retry status.");
          await tx.execute({ sql: "UPDATE generations SET bytes=?,params=json_set(params,'$.genjutsuOriginal',json(?)),updated_at=? WHERE id=?", args: [bytes.length, JSON.stringify(original), now(), id] });
        });
        stored = await storeVideoBytes(id, bytes);
      }
      if (!original) throw new Error("Missing original receipt");
      await writeGenerationOutcome({ sql: `UPDATE generations SET status='succeeded',stored_url=?,source_url=NULL,bytes=?,cost_usd=?,error=NULL,
        params=json_set(params,'$.duration',?,'$.width',?,'$.height',?,'$.ratio',?),updated_at=?
        WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.higgsfieldVideoPollToken')=? AND json_extract(params,'$.higgsfieldVideoPollUntil')>?`,
        args: [stored.url,stored.bytes,usd,original.seconds,original.width,original.height,`${original.width}:${original.height}`,now(),id,token,now()] },
        { id, kind: "video", model: String(row.model), engine: "higgsfield", status: "succeeded", engineCostUsd: usd,
          projectId: row.project_id == null ? null : String(row.project_id), shotId: row.shot_id == null ? null : String(row.shot_id), createdBy: row.created_by == null ? undefined : String(row.created_by) });
      await deliverGenerationSettlement(id);
      await settleHiggsfieldGenerationReceipt(id);
      invalidate(PROJECTS_KEY);
    } catch (error) {
      const message = error instanceof HiggsfieldHttpError && error.status === 507 ? error.message : safeFailure;
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
    if (!row || !isGenjutsuModel(String(row.model)) || row.provider !== "higgsfield" || row.kind !== "video") throw new HiggsfieldHttpError(404,"No such Genjutsu request.");
    const user = currentTenant()?.user;
    if (!user || (user.role !== "admin" && row.created_by !== user.id)) throw new HiggsfieldHttpError(403,"Only the creator or a workspace administrator can cancel this request.");
    if (["succeeded","failed","cancelled"].includes(String(row.status))) return {status: row.status as "succeeded" | "failed" | "cancelled"};
    const params = JSON.parse(String(row.params));
    const handle = params.higgsfieldVideoHandle as RenderHandle | undefined;
    if (!handle || handle.model !== row.model || handle.credentialFingerprint !== params.higgsfieldCredentialFingerprint || !params.paidClaim)
      throw new HiggsfieldHttpError(409,"The provider acknowledgement is not available yet. Refresh status before cancelling.");
    const engine = engineFor("higgsfield");
    const state = await engine.poll!(handle);
    if (state.status !== "queued") {
      if (state.status !== "running") await reconcileGenjutsuVideo(id);
      return {status: state.status};
    }
    try { await engine.cancel!(handle); }
    catch (error) {
      if (error instanceof HiggsfieldHttpError) throw error;
      throw new HiggsfieldHttpError(503,"Cancellation could not be confirmed. The request remains tracked; refresh status before trying again.");
    }
    return {status:"requested"};
  });
}
