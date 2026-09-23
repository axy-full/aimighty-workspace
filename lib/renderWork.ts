import { audioVendor } from "./xaiVoice";
import {requireTenant} from './tenant';
import { withRecoveryJob } from './recovery';
import { db, ready, now } from "./db";
import { getModel, imageTokens, SOUL_CHARACTER_MODEL_ID, MARKETING_IMAGE_MODEL_ID, isHiggsfieldImageModel } from "./models";
import { estimateImageCostUsd } from "./vendorPricing";
import { storeImageBytes, storeAudioBytes } from "./storage";
import { withRetry, billedTo } from "./providers";
import { invalidate, PROJECTS_KEY } from "./cache";
import type { Reference, ImageRole } from "./ark";
import { assertMeterFunding, FundingSourceChangedError } from "./meter";
import {
  writeGenerationOutcome,
  deliverGenerationSettlement,
} from "./generationSettlement";
import { TOPAZ_IMAGE_MODEL } from "./topaz";
import { falAwait, falStatus, falResult, FalHttpError, falSubmissionRejected } from "./fal";
import { fetchBytes } from "./mockFs";
import type { Produced as EngineProduced, RenderHandle } from "./engines/types";
import { engineFor } from "./engines";
import { higgsfieldSubmissionRejected } from "./higgsfield";
import { saveHiggsfieldGenerationReceipt, restoreHiggsfieldGenerationReceipt, settleHiggsfieldGenerationReceipt } from "./higgsfieldGenerationReceipts";
import { subscription, usdForCredits, ElevenLabsError } from "./elevenlabs";
import { inspectAudioBuffer } from "./mediaSource.server";

/**
 * The work of a still or a piece of audio, lifted out of the route that
 * asks for it.
 *
 * Both vendors are synchronous: the bytes arrive in the response, so unlike
 * ModelArk or fal there is no task to come back to. That used to mean the
 * work could only ever run inside the request's own `after()`, which has no
 * redelivery — a reclaimed instance simply lost the render.
 *
 * So the work lives here instead, in three pieces that a queue can drive:
 *
 *   load     — rebuild the job from the row it left behind
 *   produce  — the PAID part: call the vendor, keep the bytes. Returns
 *              something small, so a worker can memoise it and never pay
 *              twice for the same render.
 *   seal     — write the result to the row. Cheap, and safe to repeat.
 *
 * The route calls them in sequence when there is no queue to hand; the
 * worker calls them as separate steps. Identical behaviour either way,
 * which is the point of them being here rather than in either caller.
 */

export type RenderKind = "image" | "audio";

/* ── Loading ───────────────────────────────────────────────────────── */

type Row = {
  id: string;
  kind: string;
  model: string;
  prompt: string;
  params: string;
  status: string;
  created_at: number;
};

export type StillJob = {
  marketing?: import("./higgsfieldMarketing").MarketingSettings;
  higgsfieldCredentialFingerprint?: string;
  higgsfieldVendorCostUsd?: number;
  topaz?: import("./topaz").TopazImageSettings;
  soulReferenceId?: string;
  soulCredentialFingerprint?: string;
  soulVendorCostUsd?: number;
  soulStrength?: number;
  kind: "image";
  genId: string;
  modelId: string;
  prompt: string;
  ratio: string;
  size: string;
  references: Reference[];
  startedAt: number;
};

export type AudioTaskName = "speech" | "sound" | "music" | "dialogue" | "voiceChange";
export type AudioJob = {
  kind: "audio";
  genId: string;
  modelId: string;
  text: string;
  task: AudioTaskName;
  params: Record<string, unknown>;
  estCredits: number;
  /** Dollars, for the per-minute task (voice change); the credit tasks price from estCredits. */
  estUsd: number | null;
  startedAt: number;
};

export type Job = StillJob | AudioJob;

/**
 * Rebuild a job from its row.
 *
 * Returns null when there is nothing to do — the row is gone, or it has
 * already reached a terminal state. That second case is what makes a
 * repeated delivery harmless: a queue promises at-least-once, so this may
 * legitimately be asked to run a render that already succeeded.
 */
export async function loadJob(genId: string): Promise<Job | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id, kind, model, prompt, params, status, created_at
          FROM generations WHERE id = ? AND deleted = 0 LIMIT 1`,
    args: [genId],
  });
  const row = rs.rows[0] as unknown as Row | undefined;
  if (!row) return null;
  if (
    row.status === "succeeded" ||
    row.status === "failed" ||
    row.status === "cancelled"
  )
    return null;

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params || "{}");
  } catch {
    /* a row we cannot read is a row we cannot run */
  }
  const startedAt = Number(row.created_at);

  if (row.kind === "audio") {
    // A dubbing project is not a render: its own workflow (lib/dubbing.ts) owns the row.
    if (params.task === "dub") return null;
    const task = ["speech", "sound", "music", "dialogue", "voiceChange"].includes(
      String(params.task),
    )
      ? (params.task as AudioTaskName)
      : "speech";
    return {
      kind: "audio",
      genId: row.id,
      modelId: row.model,
      text: row.prompt,
      task,
      params,
      estCredits: Number(params.estCredits ?? 0),
      estUsd: typeof params.estUsd === "number" && Number.isFinite(params.estUsd) ? params.estUsd : null,
      startedAt,
    };
  }

  const refs = Array.isArray(params.references)
    ? (params.references as {
        uploadId?: string;
        genId?: string;
        role: string;
        kind: string;
      }[])
    : [];
  const hydrated = await hydrate(refs);
  if (row.model === MARKETING_IMAGE_MODEL_ID && hydrated.length !== refs.length)
    throw new Error("A Marketing Studio source is no longer available. Restore the original source before resuming this request.");
  return {
    kind: "image",
    genId: row.id,
    modelId: row.model,
    prompt: row.prompt,
    ratio: String(params.ratio ?? "16:9"),
    size: String(params.resolution ?? "2K"),
    topaz: params.topaz as import("./topaz").TopazImageSettings | undefined,
    marketing: params.marketing as StillJob["marketing"],
    higgsfieldCredentialFingerprint: typeof params.higgsfieldCredentialFingerprint === "string" ? params.higgsfieldCredentialFingerprint : undefined,
    higgsfieldVendorCostUsd: typeof params.higgsfieldVendorCostUsd === "number" ? params.higgsfieldVendorCostUsd : undefined,
    soulReferenceId: typeof params.soulReferenceId === "string" ? params.soulReferenceId : undefined,
    soulCredentialFingerprint: typeof params.soulCredentialFingerprint === "string" ? params.soulCredentialFingerprint : undefined,
    soulVendorCostUsd: typeof params.soulVendorCostUsd === "number" ? params.soulVendorCostUsd : undefined,
    soulStrength: typeof params.soulStrength === "number" ? params.soulStrength : undefined,
    references: hydrated,
    startedAt,
  };
}

/**
 * Reference ids on the row become the objects the vendor adapter wants.
 *
 * Two stores, and the row says which: an uploaded file under uploads/, or
 * one of our own renders under generations/. Rebuilding a job has to look in
 * the right one, which is why the row records `uploadId` or `genId` rather
 * than a bare id.
 */
async function hydrate(
  refs: { uploadId?: string; genId?: string; role: string; kind: string }[],
): Promise<Reference[]> {
  const stills = refs.filter((r) => r.kind === "image");
  if (!stills.length) return [];

  const uploadIds = stills.map((r) => r.uploadId).filter(Boolean) as string[];
  const genIds = stills.map((r) => r.genId).filter(Boolean) as string[];

  const byUpload = new Map<
    string,
    {
      id: string;
      mime: string;
      ext: string;
      stored_url: string;
      derivative_url: string | null;
    }
  >();
  if (uploadIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, derivative_url
            FROM uploads WHERE id IN (${uploadIds.map(() => "?").join(",")})`,
      args: uploadIds,
    });
    for (const r of rs.rows as unknown as {
      id: string;
      mime: string;
      ext: string;
      stored_url: string;
      derivative_url: string | null;
    }[])
      byUpload.set(r.id, r);
  }

  const ownOk = new Set<string>();
  if (genIds.length) {
    const rs = await db().execute({
      sql: `SELECT id FROM generations
            WHERE id IN (${genIds.map(() => "?").join(",")})
              AND deleted = 0 AND status = 'succeeded' AND stored_url IS NOT NULL`,
      args: genIds,
    });
    for (const r of rs.rows as unknown as { id: string }[]) ownOk.add(r.id);
  }

  const out: Reference[] = [];
  for (const r of stills) {
    if (r.genId) {
      // One of ours. Deleted since, and it is dropped rather than fatal —
      // the prompt still describes the shot.
      if (!ownOk.has(r.genId)) continue;
      out.push({
        id: r.genId,
        mime: "image/png",
        ext: "png",
        storedUrl: `/api/media/${r.genId}`,
        role: (r.role as ImageRole) ?? "reference_image",
        kind: "image",
        fromGeneration: true,
      });
      continue;
    }
    const row = r.uploadId ? byUpload.get(r.uploadId) : undefined;
    if (!row) continue;
    out.push({
      id: row.id,
      mime: row.mime,
      ext: row.ext,
      storedUrl: row.stored_url,
      role: (r.role as ImageRole) ?? "reference_image",
      kind: "image",
      deliveryUrl: row.derivative_url ?? null,
    });
  }
  return out;
}

/* ── Producing: the part that costs money ──────────────────────────── */

/** Deliberately small and serializable: a worker memoises exactly this. */
/** Where the time went, carried alongside the result so seal can record it. */
export type Timings = {
  /** Asked for → the work actually starting. On the worker this is the
   *  queue's pickup latency; inline it is near zero. */
  queueMs: number;
  /** The vendor's call, and nothing else. */
  engineMs: number;
  /** Moving the bytes into our storage. */
  storeMs: number;
};

export type Produced = { timings: Timings; bytes: number } &
  /* tokens can be null for a size the catalogue has no figure for; credits
     never is, because each of the three audio calls falls back to its own
     published rate when the vendor doesn't state one. */
  (
    | {
        kind: "image";
        storedUrl: string;
        cost: number;
        tokens: number | null;
        via: string;
      }
    | {
        kind: "audio";
        storedUrl: string;
        credits: number;
        requestId: string | null;
        /** Set by the per-minute task, whose price is dollars rather than vendor credits. */
        costUsd?: number | null;
        /** The delivered file's own length, read from its header before storing. */
        seconds?: number | null;
      }
  );

/** One durable owner for the paid step, shared by Inngest and its inline fallback.
 * A timed-out event send may still reach the worker. Neither a duplicate event
 * nor that late worker may race the inline path into a second vendor call. */
export async function claimRender(genId: string): Promise<boolean> {
  await ready();
  const claimed = await db().execute({
    sql: `UPDATE generations SET params=json_set(params, '$.paidClaim', ?), updated_at=?
      WHERE id=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params, '$.paidClaim') IS NULL`,
    args: [now(), now(), genId],
  });
  return claimed.rowsAffected > 0;
}

export async function producedOutcome(genId: string): Promise<Produced | null> {
  const row = (
    await db().execute({
      sql: `SELECT json_extract(params,'$.producedOutcome') AS outcome FROM generations WHERE id=? AND deleted=0`,
      args: [genId],
    })
  ).rows[0];
  return row?.outcome ? (JSON.parse(String(row.outcome)) as Produced) : null;
}

export async function produce(job: Job): Promise<Produced | null> {
return await withRecoveryJob(requireTenant().id, job.genId, async () => {

  const previous = await producedOutcome(job.genId);
  if (previous) return previous;
  if (!(await claimRender(job.genId))) return producedOutcome(job.genId);
  try {
    await assertMeterFunding(
      job.genId,
      job.kind === "audio"
        ? audioVendor(job.modelId)
        : billedTo(getModel(job.modelId).provider),
    );
    const out =
      job.kind === "audio" ? await produceAudio(job) : await produceStill(job);
    if (!out) return null;
    // Persist the small result independently of queue step memoization, so
    // the record step can recover after an inline/worker handoff or restart.
    await withRetry(
      () =>
        db().execute({
          sql: `UPDATE generations SET params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=?`,
          args: [JSON.stringify(out), now(), job.genId],
        }),
      { max: 3 },
    );
    return out;
  } catch (error) {
    if (job.kind === "image" && isHiggsfieldImageModel(job.modelId) &&
        !(error instanceof FundingSourceChangedError) && !higgsfieldSubmissionRejected(error)) {
      // An unconfirmed POST or interrupted acknowledgement is not a terminal
      // provider outcome. Keep the reservation and permanent submit-once claim.
      // A saved independent receipt lets polling restore a lost tenant handle.
      await db().execute({ sql: "UPDATE generations SET error=?,updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
        args: ["The connected-account request outcome is unconfirmed. Its reservation remains pending; this request will not be submitted again. Collection will resume if its accepted request receipt is available.", now(), job.genId] }).catch(() => {});
      return null;
    }
    // A synchronous vendor may have charged before the connection failed.
    // Leave the claim intact: automatic retries must never buy it again.
    await failJob(
      job.genId,
      (error as Error).message,
      error instanceof FundingSourceChangedError || falSubmissionRejected(error) || higgsfieldSubmissionRejected(error) ||
        (error instanceof ElevenLabsError && error.rejectedBeforeGeneration),
    );
    throw error;
  }

});
}

async function produceStill(job: StillJob): Promise<Produced | null> {
  const model = getModel(job.modelId);
  const queueMs = Math.max(0, now() - job.startedAt);
  const engineStart = now();
  const out = await engineFor(model.provider).render({
    kind: "image",
    genId: job.genId,
    model,
    prompt: job.prompt,
    ratio: job.ratio,
    size: job.size,
    topaz: job.topaz,
    marketing: job.marketing,
    higgsfieldCredentialFingerprint: job.higgsfieldCredentialFingerprint,
    higgsfieldVendorCostUsd: job.higgsfieldVendorCostUsd,
    soulReferenceId: job.soulReferenceId,
    soulCredentialFingerprint: job.soulCredentialFingerprint,
    soulStrength: job.soulStrength,
    references: job.references,
  });
  if (!("produced" in out)) {
    if (isHiggsfieldImageModel(job.modelId) && out.handle.provider === "higgsfield") {
      let receiptSaved = false;
      try {
        await saveHiggsfieldGenerationReceipt(job.genId, out.handle, (job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldCredentialFingerprint : job.soulCredentialFingerprint)!);
        receiptSaved = true;
      } catch { /* Still attempt the independent tenant write. */ }
      try {
        await withRetry(async () => {
          const saved = await db().execute({
            sql: "UPDATE generations SET params=json_set(params,'$.higgsfieldStillHandle',json(?)),updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
            args: [JSON.stringify(out.handle), now(), job.genId],
          });
          if (!saved.rowsAffected) throw new Error("The connected-account generation record could not retain its accepted request.");
        }, { max: 3 });
      } catch (error) {
        if (!receiptSaved) await saveHiggsfieldGenerationReceipt(job.genId, out.handle, (job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldCredentialFingerprint : job.soulCredentialFingerprint)!).catch(() => {});
        throw error;
      }
      if (!receiptSaved) await saveHiggsfieldGenerationReceipt(job.genId, out.handle, (job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldCredentialFingerprint : job.soulCredentialFingerprint)!).catch(() => {});
      try { await reconcileHiggsfieldImage(job.genId); } catch {
        // The collector stores a safe error. The saved handle and paid claim
        // remain recoverable through ordinary polling and the pending janitor.
      }
      return producedOutcome(job.genId);
    }
    if (job.modelId !== TOPAZ_IMAGE_MODEL || out.handle.provider !== "fal")
      throw new Error("The still engine returned an unsupported queue handle.");
    await withRetry(() => db().execute({
      sql: "UPDATE generations SET params=json_set(params,'$.falStillRequestId',?),updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
      args: [out.handle.ref, now(), job.genId],
    }), { max: 3 });
    try {
      await falAwait(TOPAZ_IMAGE_MODEL, out.handle.ref, { timeoutMs: 150_000, pollMs: 3000 });
      await reconcileTopazImage(job.genId);
    } catch (error) {
      // The acknowledged job survives this function. Cron and explicit polling
      // continue collecting it; never turn a lost poll into another paid submit.
      console.warn("Topaz collection deferred:", (error as Error).message);
    }
    return producedOutcome(job.genId);
  }
  return finishStill(job, out.produced, queueMs, now() - engineStart);
}

/** Collect one acknowledged Soul request. This path never submits a generation. */
export async function reconcileHiggsfieldImage(genId: string): Promise<void> {
  return withRecoveryJob(requireTenant().id, genId, async () => {
    await restoreHiggsfieldGenerationReceipt(genId);
    const until = now() + 180_000;
    const claim = await db().execute({
      sql: `UPDATE generations SET params=json_set(params,'$.higgsfieldStillPollUntil',?)
        WHERE id=? AND kind='image' AND model IN (?,?) AND provider='higgsfield' AND deleted=0 AND status IN ('queued','running')
        AND json_extract(params,'$.higgsfieldStillHandle') IS NOT NULL
        AND COALESCE(json_extract(params,'$.higgsfieldStillPollUntil'),0) < ? RETURNING params`,
      args: [until, genId, SOUL_CHARACTER_MODEL_ID, MARKETING_IMAGE_MODEL_ID, now()],
    });
    if (!claim.rows.length) return;
    const params = JSON.parse(String(claim.rows[0].params));
    try {
      const job = await loadJob(genId);
      if (!job || job.kind !== "image") return;
      const previous = await producedOutcome(genId);
      if (previous) { await seal(job, previous); await settleHiggsfieldGenerationReceipt(genId); return; }
      const engine = engineFor("higgsfield");
      const saved = params.higgsfieldStillHandle as RenderHandle;
      if (saved.model !== job.modelId) throw new Error("The accepted request model does not match its original admission.");
      const credentialFingerprint = job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldCredentialFingerprint : job.soulCredentialFingerprint;
      const vendorCostUsd = job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldVendorCostUsd : job.soulVendorCostUsd;
      const state = await engine.poll!({ ...saved, credentialFingerprint });
      if (state.status === "failed" || state.status === "cancelled") {
        // Higgsfield documents failed, NSFW and canceled requests as uncharged.
        await failJob(genId, state.error ?? "The connected-account request was canceled.", true);
        await settleHiggsfieldGenerationReceipt(genId);
        return;
      }
      if (state.status !== "succeeded") {
        await db().execute({ sql: "UPDATE generations SET status=?,error=NULL,updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
          args: [state.status, now(), genId] });
        return;
      }
      if (!state.imageUrl || !Number.isFinite(vendorCostUsd) || !(vendorCostUsd! > 0))
        throw new Error("The connected-account request needs its saved image and verified price before collection can finish.");
      const out = await finishStill(job, {
        bytes: await engine.fetchMaster!(state.imageUrl), mime: "image/png",
        costUsd: vendorCostUsd!, totalTokens: null, via: "higgsfield", requestId: saved.ref,
      }, 0, now() - job.startedAt);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
        args: [JSON.stringify(out), now(), genId] });
      await seal(job, out);
      await settleHiggsfieldGenerationReceipt(genId);
    } catch (error) {
      // Transport, connection rotation and storage failures never imply a refund.
      // Preserve both the original request handle and its existing reservation.
      const message = error instanceof Error ? error.message : "Soul collection could not complete.";
      await db().execute({ sql: "UPDATE generations SET error=?,updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0",
        args: [message.slice(0, 600), now(), genId] });
      throw error;
    } finally {
      await db().execute({ sql: "UPDATE generations SET params=json_remove(params,'$.higgsfieldStillPollUntil') WHERE id=? AND json_extract(params,'$.higgsfieldStillPollUntil')=?",
        args: [genId, until] });
    }
  });
}

async function finishStill(job: StillJob, img: EngineProduced, queueMs: number, engineMs: number): Promise<Produced> {
  // Google can only emit JPEG; the library keeps PNG. Decode once and
  // re-encode LOSSLESSLY — pixel-identical, and nothing downstream can add
  // generation loss to a PNG. (sharp is for THIS transcode and for delivery
  // copies only — reference masters never pass through it.)
  const sharp = (await import("sharp")).default;
  let png: Buffer;
  if (job.modelId === TOPAZ_IMAGE_MODEL) {
    const meta = await sharp(img.bytes, { limitInputPixels: 48_000_000 }).metadata();
    if (meta.format !== "png" || !meta.width || !meta.height || meta.width * meta.height > 48_000_000)
      throw new Error("Topaz returned an unsupported master. The original provider request is retained for review.");
    png = img.bytes; // Keep precision, color profile and metadata; the requested PNG needs no transcode.
  } else png = await sharp(img.bytes).png().toBuffer();
  const storeStart = now();
  /* Google has already drawn and charged for this image. A brief Blob
     outage here would otherwise throw the whole render away. The put is
     idempotent (allowOverwrite) and costs nothing per attempt, so unlike a
     vendor call it is safe to try again. */
  const { value: stored } = await withRetry(
    () => storeImageBytes(job.genId, png),
    { max: 3 },
  );
  // The gateway states the exact charge; Google direct bills flat per image
  // by size (+ a little per reference in), from the catalogue.
  const cost =
    img.costUsd ??
    estimateImageCostUsd(job.modelId, job.size, job.references.length)?.net ??
    0;
  const tokens =
    img.totalTokens ?? imageTokens(job.size, job.references.length);
  return {
    kind: "image",
    storedUrl: stored.url,
    bytes: stored.bytes,
    cost,
    tokens,
    via: img.via ?? "direct",
    // The transcode sits between the two, and is counted with the store:
    // it is our work, not the engine's.
    timings: { queueMs, engineMs, storeMs: now() - storeStart },
  };
}

/** Polling never submits. A per-job lease avoids parallel file downloads across tabs/workers. */
export async function reconcileTopazImage(genId: string): Promise<void> {
  return withRecoveryJob(requireTenant().id, genId, async () => {
    const until = now() + 300_000;
    const claim = await db().execute({
      sql: `UPDATE generations SET params=json_set(params,'$.falStillPollUntil',?)
        WHERE id=? AND kind='image' AND model=? AND deleted=0 AND status IN ('queued','running')
        AND json_extract(params,'$.falStillRequestId') IS NOT NULL
        AND COALESCE(json_extract(params,'$.falStillPollUntil'),0) < ? RETURNING params`,
      args: [until, genId, TOPAZ_IMAGE_MODEL, now()],
    });
    if (!claim.rows.length) return;
    const params = JSON.parse(String(claim.rows[0].params));
    try {
      const job = await loadJob(genId);
      if (!job || job.kind !== "image") return;
      const previous = await producedOutcome(genId);
      if (previous) { await seal(job, previous); return; }
      const state = await falStatus(TOPAZ_IMAGE_MODEL, String(params.falStillRequestId));
      if (state.status !== "COMPLETED") return;
      const result = await falResult<{ image?: { url?: string; content_type?: string } }>(TOPAZ_IMAGE_MODEL, String(params.falStillRequestId));
      if (!result.image?.url) throw new Error("Topaz returned no image. The existing request remains available for reconciliation.");
      const out = await finishStill(job, { bytes: await fetchBytes(result.image.url, 60_000, 200 * 1024 * 1024), mime: result.image.content_type ?? "image/png",
        costUsd: estimateImageCostUsd(job.modelId, job.size, 0)?.net ?? null, totalTokens: null, via: "fal" }, 0, now() - job.startedAt);
      await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=? AND status IN ('queued','running') AND deleted=0", args: [JSON.stringify(out), now(), genId] });
      await seal(job, out);
    } catch (error) {
      // A refused result is terminal; a transport/storage failure keeps the
      // known handle and reservation so the same render can be collected later.
      if (error instanceof FalHttpError && [400, 422].includes(error.status)) await failJob(genId, error.message, true);
      else {
        await db().execute({ sql: "UPDATE generations SET error=?,updated_at=? WHERE id=? AND status IN ('queued','running')", args: [(error as Error).message.slice(0,600), now(), genId] });
        throw error;
      }
    } finally {
      await db().execute({ sql: "UPDATE generations SET params=json_remove(params,'$.falStillPollUntil') WHERE id=? AND json_extract(params,'$.falStillPollUntil')=?", args: [genId, until] });
    }
  });
}

async function produceAudio(job: AudioJob): Promise<Produced> {
  const p = job.params;
  const queueMs = Math.max(0, now() - job.startedAt);
  const engineStart = now();
  const res = await engineFor(audioVendor(job.modelId)).render({
    kind: "audio",
    genId: job.genId,
    modelId: job.modelId,
    task: job.task,
    text: job.text,
    params: p as Record<string, unknown>,
  });
  if (!("produced" in res))
    throw new Error(
      "The sound engine answered with a job where bytes were expected.",
    );
  const out = res.produced;
  const engineMs = now() - engineStart;
  /* ElevenLabs has already spoken the line and taken the credits. A Blob
     blip must not throw that away; the put is idempotent. */
  const storeStart = now();
  const { value: stored } = await withRetry(
    () => storeAudioBytes(job.genId, out.bytes),
    { max: 3 },
  );
  // The track's own length, from its header (bounded, in memory); null when unreadable.
  const seconds = await inspectAudioBuffer(out.bytes).then((m) => Math.round(m.seconds * 1000) / 1000).catch(() => null);
  return {
    kind: "audio",
    storedUrl: stored.url,
    bytes: stored.bytes,
    credits: out.credits ?? 0,
    requestId: out.requestId ?? null,
    ...(out.costUsd != null ? { costUsd: out.costUsd } : {}),
    seconds,
    timings: { queueMs, engineMs, storeMs: now() - storeStart },
  };
}

/* ── Sealing: writing the outcome down ─────────────────────────────── */

export async function seal(job: Job, produced: Produced): Promise<void> {
return await withRecoveryJob(requireTenant().id, job.genId, async () => {

  const ms = Math.max(0, now() - job.startedAt);
  const t = produced.timings;
  if (produced.kind === "image") {
    const ratePerM = produced.tokens
      ? (produced.cost / produced.tokens) * 1_000_000
      : null;
    await writeGenerationOutcome(
      {
        /* billed_to is written from the door that ACTUALLY served this
         render, not from the one the environment implies. A still can fall
         back between doors mid-render, and the ledger has to follow the
         money rather than the intent: through the gateway it is Vercel
         credit, on the Google key it is Google's account. Guessing at
         insert time was right until the day a fallback fired. */
        sql: `UPDATE generations
            SET status='succeeded', stored_url=?, total_tokens=?,
                cost_usd=?, rate_usd_per_m=?, error=NULL, duration_ms=?,
                queue_ms=?, engine_ms=?, store_ms=?, bytes=?,
                params=json_set(params, '$.via', ?), billed_to=?, updated_at=?
            WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [
          produced.storedUrl,
          produced.tokens,
          produced.cost,
          ratePerM,
          ms,
          t.queueMs,
          t.engineMs,
          t.storeMs,
          produced.bytes,
          produced.via,
          produced.via === "higgsfield" || produced.via === "fal" || produced.via === "google" || produced.via === "openai" || produced.via === "xai"
            ? produced.via
            : "vercel",
          now(),
          job.genId,
        ],
      },
      {
        id: job.genId,
        kind: "image",
        engine:
          produced.via === "higgsfield" || produced.via === "fal" || produced.via === "google" || produced.via === "openai" || produced.via === "xai"
            ? produced.via
            : "vercel",
        model: job.modelId,
        status: "succeeded",
        engineCostUsd: produced.cost,
        durationMs: ms,
      },
    );
    await deliverGenerationSettlement(job.genId);
  } else {
    // Price from the plan the account is on; the tier is read once per render.
    let tier: string | null = null;
    try {
      tier = (await subscription()).tier;
    } catch {
      /* estimate at the fallback rate */
    }
    const credits = produced.credits;
    // A per-minute task states its dollars itself; the credit tasks price from the plan.
    const cost = produced.costUsd != null ? produced.costUsd : usdForCredits(credits, tier);
    await writeGenerationOutcome(
      {
        sql: `UPDATE generations
            SET status='succeeded', stored_url=?, total_tokens=?, cost_usd=?, rate_usd_per_m=?,
                error=NULL, duration_ms=?, queue_ms=?, engine_ms=?, store_ms=?, bytes=?,
                duration_s=COALESCE(?, duration_s),
                params=json_set(params, '$.credits', ?, '$.tier', ?, '$.requestId', ?), updated_at=?
            WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
        args: [
          produced.storedUrl,
          credits,
          cost,
          credits ? (cost / credits) * 1_000_000 : null,
          ms,
          t.queueMs,
          t.engineMs,
          t.storeMs,
          produced.bytes,
          produced.seconds ?? null,
          credits,
          tier,
          produced.requestId,
          now(),
          job.genId,
        ],
      },
      {
        id: job.genId,
        kind: "audio",
        engine: audioVendor(job.modelId),
        model: job.modelId,
        status: "succeeded",
        engineCostUsd: cost,
        durationMs: ms,
      },
    );
    await deliverGenerationSettlement(job.genId);
  }
  invalidate(PROJECTS_KEY);

});
}

/**
 * The render is over and there is nothing to show for it.
 *
 * The estimated cost goes on the row even in failure: if the engine drew it
 * or the voice spoke it, the money is gone whether or not we managed to keep
 * the file, and dropping it here is how a real charge disappears from the
 * ledger.
 */
export async function failJob(
  genId: string,
  message: string,
  rejectedBeforeGeneration = false,
): Promise<void> {
return await withRecoveryJob(requireTenant().id, genId, async () => {

  await ready();
  const job = await loadJob(genId).catch(() => null);
  const ms = job ? Math.max(0, now() - job.startedAt) : null;
  const spentUsd = rejectedBeforeGeneration
    ? 0
    : job?.kind === "audio"
      ? (job.estUsd ?? usdForCredits(job.estCredits, null))
      : job?.kind === "image"
        ? (isHiggsfieldImageModel(job.modelId) ? (job.modelId === MARKETING_IMAGE_MODEL_ID ? job.higgsfieldVendorCostUsd : job.soulVendorCostUsd) ?? null : estimateImageCostUsd(job.modelId, job.size, job.references.length)
            ?.net ?? null)
        : null;
  const spentCredits = rejectedBeforeGeneration
    ? 0
    : job?.kind === "audio"
      ? job.estCredits || null
      : null;
  if (!job) {
    await deliverGenerationSettlement(genId);
    return;
  }
  await writeGenerationOutcome(
    {
      sql: `UPDATE generations
      SET status='failed', error=?, duration_ms=COALESCE(duration_ms, ?),
          cost_usd=COALESCE(cost_usd, ?), total_tokens=COALESCE(total_tokens, ?), updated_at=?
      WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
      args: [message.slice(0, 600), ms, spentUsd, spentCredits, now(), genId],
    },
    {
      id: genId,
      kind: job.kind,
      engine:
        job.kind === "audio"
          ? "elevenlabs"
          : billedTo(getModel(job.modelId).provider),
      model: job.modelId,
      status: "failed",
      // Retain the original reservation for an ambiguous provider/storage failure.
      engineCostUsd: rejectedBeforeGeneration ? 0 : null,
      durationMs: ms,
    },
  );
  await deliverGenerationSettlement(genId);
  invalidate(PROJECTS_KEY);

});
}

/**
 * The whole job, start to finish, in one go. This is the fallback path the
 * route takes when there is no queue to hand — the old behaviour exactly,
 * now sharing its body with the worker.
 */
export async function runInline(genId: string): Promise<void> {
return await withRecoveryJob(requireTenant().id, genId, async () => {

  try {
    const job = await loadJob(genId);
    if (!job) return;
    const produced = await produce(job);
    if (produced) await seal(job, produced);
  } catch (e) {
    await failJob(genId, (e as Error).message);
  }

});
}
