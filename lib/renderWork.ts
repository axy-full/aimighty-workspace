import { db, ready, now } from "./db";
import { getModel, imageTokens } from "./models";
import { estimateImageCostUsd } from "./vendorPricing";
import { storeImageBytes, storeAudioBytes } from "./storage";
import { withRetry, billedTo } from "./providers";
import { invalidate, PROJECTS_KEY } from "./cache";
import type { Reference, ImageRole } from "./ark";
import { meter } from "./meter";
import { engineFor } from "./engines";
import { subscription, usdForCredits } from "./elevenlabs";

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
  id: string; kind: string; model: string; prompt: string;
  params: string; status: string; created_at: number;
};

export type StillJob = {
  kind: "image";
  genId: string;
  modelId: string;
  prompt: string;
  ratio: string;
  size: string;
  references: Reference[];
  startedAt: number;
};

export type AudioJob = {
  kind: "audio";
  genId: string;
  modelId: string;
  text: string;
  task: "speech" | "sound" | "music";
  params: Record<string, unknown>;
  estCredits: number;
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
  if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") return null;

  let params: Record<string, unknown> = {};
  try { params = JSON.parse(row.params || "{}"); } catch { /* a row we cannot read is a row we cannot run */ }
  const startedAt = Number(row.created_at);

  if (row.kind === "audio") {
    const task = ["speech", "sound", "music"].includes(String(params.task))
      ? (params.task as "speech" | "sound" | "music") : "speech";
    return {
      kind: "audio", genId: row.id, modelId: row.model, text: row.prompt,
      task, params, estCredits: Number(params.estCredits ?? 0), startedAt,
    };
  }

  const refs = Array.isArray(params.references)
    ? (params.references as { uploadId?: string; genId?: string; role: string; kind: string }[]) : [];
  return {
    kind: "image", genId: row.id, modelId: row.model, prompt: row.prompt,
    ratio: String(params.ratio ?? "16:9"),
    size: String(params.resolution ?? "2K"),
    references: await hydrate(refs),
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
  refs: { uploadId?: string; genId?: string; role: string; kind: string }[]
): Promise<Reference[]> {
  const stills = refs.filter((r) => r.kind === "image");
  if (!stills.length) return [];

  const uploadIds = stills.map((r) => r.uploadId).filter(Boolean) as string[];
  const genIds = stills.map((r) => r.genId).filter(Boolean) as string[];

  const byUpload = new Map<string, {
    id: string; mime: string; ext: string; stored_url: string; derivative_url: string | null;
  }>();
  if (uploadIds.length) {
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, derivative_url
            FROM uploads WHERE id IN (${uploadIds.map(() => "?").join(",")})`,
      args: uploadIds,
    });
    for (const r of rs.rows as unknown as {
      id: string; mime: string; ext: string; stored_url: string; derivative_url: string | null;
    }[]) byUpload.set(r.id, r);
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
        id: r.genId, mime: "image/png", ext: "png",
        storedUrl: `/api/media/${r.genId}`,
        role: (r.role as ImageRole) ?? "reference_image", kind: "image",
        fromGeneration: true,
      });
      continue;
    }
    const row = r.uploadId ? byUpload.get(r.uploadId) : undefined;
    if (!row) continue;
    out.push({
      id: row.id, mime: row.mime, ext: row.ext, storedUrl: row.stored_url,
      role: (r.role as ImageRole) ?? "reference_image", kind: "image",
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

export type Produced = { timings: Timings; bytes: number } & (
  /* tokens can be null for a size the catalogue has no figure for; credits
     never is, because each of the three audio calls falls back to its own
     published rate when the vendor doesn't state one. */
  | { kind: "image"; storedUrl: string; cost: number; tokens: number | null; via: string }
  | { kind: "audio"; storedUrl: string; credits: number; requestId: string | null }
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
  const row = (await db().execute({ sql: `SELECT json_extract(params,'$.producedOutcome') AS outcome FROM generations WHERE id=? AND deleted=0`, args: [genId] })).rows[0];
  return row?.outcome ? JSON.parse(String(row.outcome)) as Produced : null;
}

export async function produce(job: Job): Promise<Produced | null> {
  const previous = await producedOutcome(job.genId);
  if (previous) return previous;
  if (!(await claimRender(job.genId))) return producedOutcome(job.genId);
  try {
    const out = job.kind === "audio" ? await produceAudio(job) : await produceStill(job);
    // Persist the small result independently of queue step memoization, so
    // the record step can recover after an inline/worker handoff or restart.
    await withRetry(() => db().execute({
      sql: `UPDATE generations SET params=json_set(params,'$.producedOutcome',json(?)),updated_at=? WHERE id=?`,
      args: [JSON.stringify(out), now(), job.genId],
    }), { max: 3 });
    return out;
  } catch (error) {
    // A synchronous vendor may have charged before the connection failed.
    // Leave the claim intact: automatic retries must never buy it again.
    await failJob(job.genId, (error as Error).message);
    throw error;
  }
}

async function produceStill(job: StillJob): Promise<Produced> {
  const model = getModel(job.modelId);
  const queueMs = Math.max(0, now() - job.startedAt);
  const engineStart = now();
  const out = await engineFor(model.provider).render({ kind: "image", genId: job.genId, model, prompt: job.prompt, ratio: job.ratio, size: job.size, references: job.references });
  if (!("produced" in out)) throw new Error("The still engine answered with a job where bytes were expected.");
  const img = out.produced;
  const engineMs = now() - engineStart;
  // Google can only emit JPEG; the library keeps PNG. Decode once and
  // re-encode LOSSLESSLY — pixel-identical, and nothing downstream can add
  // generation loss to a PNG. (sharp is for THIS transcode and for delivery
  // copies only — reference masters never pass through it.)
  const sharp = (await import("sharp")).default;
  const png = await sharp(img.bytes).png().toBuffer();
  const storeStart = now();
  /* Google has already drawn and charged for this image. A brief Blob
     outage here would otherwise throw the whole render away. The put is
     idempotent (allowOverwrite) and costs nothing per attempt, so unlike a
     vendor call it is safe to try again. */
  const { value: stored } = await withRetry(() => storeImageBytes(job.genId, png), { max: 3 });
  // The gateway states the exact charge; Google direct bills flat per image
  // by size (+ a little per reference in), from the catalogue.
  const cost = img.costUsd
    ?? (estimateImageCostUsd(job.modelId, job.size, job.references.length)?.net ?? 0);
  const tokens = img.totalTokens ?? imageTokens(job.size, job.references.length);
  return {
    kind: "image", storedUrl: stored.url, bytes: stored.bytes, cost, tokens, via: img.via ?? "direct",
    // The transcode sits between the two, and is counted with the store:
    // it is our work, not the engine's.
    timings: { queueMs, engineMs, storeMs: now() - storeStart },
  };
}

async function produceAudio(job: AudioJob): Promise<Produced> {
  const p = job.params;
  const queueMs = Math.max(0, now() - job.startedAt);
  const engineStart = now();
  const { value: out } = await withRetry(async () => {
    const res = await engineFor("elevenlabs").render({ kind: "audio", genId: job.genId, modelId: job.modelId, task: job.task, text: job.text, params: p as Record<string, unknown> });
    if (!("produced" in res)) throw new Error("The sound engine answered with a job where bytes were expected.");
    return res.produced;
  }, { max: 2 });
  const engineMs = now() - engineStart;
  /* ElevenLabs has already spoken the line and taken the credits. A Blob
     blip must not throw that away; the put is idempotent. */
  const storeStart = now();
  const { value: stored } = await withRetry(() => storeAudioBytes(job.genId, out.bytes), { max: 3 });
  return {
    kind: "audio", storedUrl: stored.url, bytes: stored.bytes,
    credits: out.credits ?? 0, requestId: out.requestId ?? null,
    timings: { queueMs, engineMs, storeMs: now() - storeStart },
  };
}

/* ── Sealing: writing the outcome down ─────────────────────────────── */

export async function seal(job: Job, produced: Produced): Promise<void> {
  const ms = Math.max(0, now() - job.startedAt);
  const t = produced.timings;
  if (produced.kind === "image") {
    const ratePerM = produced.tokens ? (produced.cost / produced.tokens) * 1_000_000 : null;
    await db().execute({
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
            WHERE id=?`,
      args: [produced.storedUrl, produced.tokens, produced.cost, ratePerM, ms,
             t.queueMs, t.engineMs, t.storeMs, produced.bytes,
             produced.via, produced.via === "google" ? "google" : "vercel",
             now(), job.genId],
    });
    await meter({ id: job.genId, kind: "image", engine: produced.via === "google" ? "google" : "vercel", model: job.modelId,
                  status: "succeeded", engineCostUsd: produced.cost, durationMs: ms }, { critical: false });
  } else {
    // Price from the plan the account is on; the tier is read once per render.
    let tier: string | null = null;
    try { tier = (await subscription()).tier; } catch { /* estimate at the fallback rate */ }
    const credits = produced.credits;
    const cost = usdForCredits(credits, tier);
    await db().execute({
      sql: `UPDATE generations
            SET status='succeeded', stored_url=?, total_tokens=?, cost_usd=?, rate_usd_per_m=?,
                error=NULL, duration_ms=?, queue_ms=?, engine_ms=?, store_ms=?, bytes=?,
                params=json_set(params, '$.credits', ?, '$.tier', ?, '$.requestId', ?), updated_at=?
            WHERE id=?`,
      args: [produced.storedUrl, credits, cost, credits ? (cost / credits) * 1_000_000 : null,
             ms, t.queueMs, t.engineMs, t.storeMs, produced.bytes,
             credits, tier, produced.requestId, now(), job.genId],
    });
    await meter({ id: job.genId, kind: "audio", engine: "elevenlabs", model: job.modelId, status: "succeeded", engineCostUsd: cost, durationMs: ms }, { critical: false });
  }
  invalidate(PROJECTS_KEY);
}

/**
 * The render is over and there is nothing to show for it.
 *
 * The estimated cost goes on the row even in failure: if the engine drew it
 * or the voice spoke it, the money is gone whether or not we managed to keep
 * the file, and dropping it here is how a real charge disappears from the
 * ledger.
 */
export async function failJob(genId: string, message: string): Promise<void> {
  await ready();
  const job = await loadJob(genId).catch(() => null);
  const ms = job ? Math.max(0, now() - job.startedAt) : null;
  const spentUsd = job?.kind === "image"
    ? estimateImageCostUsd(job.modelId, job.size, job.references.length)?.net ?? null
    : null;
  const spentCredits = job?.kind === "audio" ? job.estCredits || null : null;
  await db().execute({
    sql: `UPDATE generations
          SET status='failed', error=?,
              duration_ms=COALESCE(duration_ms, ?),
              cost_usd=COALESCE(cost_usd, ?),
              total_tokens=COALESCE(total_tokens, ?),
              updated_at=?
          WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
    args: [message.slice(0, 600), ms, spentUsd, spentCredits, now(), genId],
  }).catch(() => {});
  if (job) {
    await meter({ id: genId, kind: job.kind, engine: job.kind === "audio" ? "elevenlabs" : billedTo("google"), model: job.modelId, status: "failed",
                  engineCostUsd: job.kind === "audio" ? usdForCredits(spentCredits ?? 0, null) : (spentUsd ?? 0), durationMs: ms }, { critical: false }).catch(() => {});
  }
  invalidate(PROJECTS_KEY);
}

/**
 * The whole job, start to finish, in one go. This is the fallback path the
 * route takes when there is no queue to hand — the old behaviour exactly,
 * now sharing its body with the worker.
 */
export async function runInline(genId: string): Promise<void> {
  try {
    const job = await loadJob(genId);
    if (!job) return;
    const produced = await produce(job);
    if (produced) await seal(job, produced);
  } catch (e) {
    await failJob(genId, (e as Error).message);
  }
}
