import { db, ready, now } from "./db";
import { getModel, estimateImageCostUsd, imageTokens } from "./models";
import { generateImage } from "./gemini";
import { textToSpeech, soundEffect, composeMusic, subscription, usdForCredits } from "./elevenlabs";
import { storeImageBytes, storeAudioBytes } from "./storage";
import { withRetry } from "./providers";
import { invalidate, PROJECTS_KEY } from "./cache";
import type { Reference, ImageRole } from "./ark";

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
    ? (params.references as { uploadId: string; role: string; kind: string }[]) : [];
  return {
    kind: "image", genId: row.id, modelId: row.model, prompt: row.prompt,
    ratio: String(params.ratio ?? "16:9"),
    size: String(params.resolution ?? "2K"),
    references: await hydrate(refs),
    startedAt,
  };
}

/** Reference ids on the row become the objects the vendor adapter wants. */
async function hydrate(
  refs: { uploadId: string; role: string; kind: string }[]
): Promise<Reference[]> {
  const wanted = refs.filter((r) => r.kind === "image").map((r) => r.uploadId);
  if (!wanted.length) return [];
  const rs = await db().execute({
    sql: `SELECT id, mime, ext, stored_url, derivative_url
          FROM uploads WHERE id IN (${wanted.map(() => "?").join(",")})`,
    args: wanted,
  });
  const byId = new Map(
    (rs.rows as unknown as {
      id: string; mime: string; ext: string; stored_url: string; derivative_url: string | null;
    }[]).map((r) => [r.id, r])
  );
  const out: Reference[] = [];
  for (const r of refs) {
    const row = byId.get(r.uploadId);
    // A reference deleted since the render was asked for is dropped rather
    // than fatal: the prompt still describes the shot.
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
export type Produced =
  /* tokens can be null for a size the catalogue has no figure for; credits
     never is, because each of the three audio calls falls back to its own
     published rate when the vendor doesn't state one. */
  | { kind: "image"; storedUrl: string; cost: number; tokens: number | null; via: string }
  | { kind: "audio"; storedUrl: string; credits: number; requestId: string | null };

export async function produce(job: Job): Promise<Produced> {
  return job.kind === "audio" ? produceAudio(job) : produceStill(job);
}

async function produceStill(job: StillJob): Promise<Produced> {
  const model = getModel(job.modelId);
  const img = await generateImage({
    model, prompt: job.prompt, ratio: job.ratio, size: job.size, references: job.references,
  });
  // Google can only emit JPEG; the library keeps PNG. Decode once and
  // re-encode LOSSLESSLY — pixel-identical, and nothing downstream can add
  // generation loss to a PNG. (sharp is for THIS transcode and for delivery
  // copies only — reference masters never pass through it.)
  const sharp = (await import("sharp")).default;
  const png = await sharp(img.bytes).png().toBuffer();
  /* Google has already drawn and charged for this image. A brief Blob
     outage here would otherwise throw the whole render away. The put is
     idempotent (allowOverwrite) and costs nothing per attempt, so unlike a
     vendor call it is safe to try again. */
  const { value: storedUrl } = await withRetry(() => storeImageBytes(job.genId, png), { max: 3 });
  // The gateway states the exact charge; Google direct bills flat per image
  // by size (+ a little per reference in), from the catalogue.
  const cost = img.costUsd
    ?? (estimateImageCostUsd(job.modelId, job.size, job.references.length)?.net ?? 0);
  const tokens = img.totalTokens ?? imageTokens(job.size, job.references.length);
  return { kind: "image", storedUrl, cost, tokens, via: img.via };
}

async function produceAudio(job: AudioJob): Promise<Produced> {
  const p = job.params;
  const { value: out } = await withRetry(async () => {
    if (job.task === "speech") {
      return textToSpeech({
        voiceId: String(p.voiceId), text: job.text, modelId: job.modelId,
        settings: Object.fromEntries(
          Object.entries((p.settings ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined)
        ),
      });
    }
    if (job.task === "sound") {
      return soundEffect({
        text: job.text, durationSeconds: p.durationSeconds as number | null,
        promptInfluence: p.promptInfluence as number | undefined, loop: Boolean(p.loop),
      });
    }
    return composeMusic({
      prompt: job.text, lengthMs: p.lengthMs as number, instrumental: Boolean(p.instrumental),
    });
  }, { max: 2 });
  /* ElevenLabs has already spoken the line and taken the credits. A Blob
     blip must not throw that away; the put is idempotent. */
  const { value: storedUrl } = await withRetry(() => storeAudioBytes(job.genId, out.bytes), { max: 3 });
  return { kind: "audio", storedUrl, credits: out.credits, requestId: out.requestId };
}

/* ── Sealing: writing the outcome down ─────────────────────────────── */

export async function seal(job: Job, produced: Produced): Promise<void> {
  const ms = Math.max(0, now() - job.startedAt);
  if (produced.kind === "image") {
    const ratePerM = produced.tokens ? (produced.cost / produced.tokens) * 1_000_000 : null;
    await db().execute({
      sql: `UPDATE generations
            SET status='succeeded', stored_url=?, total_tokens=?,
                cost_usd=?, rate_usd_per_m=?, error=NULL, duration_ms=?,
                params=json_set(params, '$.via', ?), updated_at=?
            WHERE id=?`,
      args: [produced.storedUrl, produced.tokens, produced.cost, ratePerM, ms,
             produced.via, now(), job.genId],
    });
  } else {
    // Price from the plan the account is on; the tier is read once per render.
    let tier: string | null = null;
    try { tier = (await subscription()).tier; } catch { /* estimate at the fallback rate */ }
    const credits = produced.credits;
    const cost = usdForCredits(credits, tier);
    await db().execute({
      sql: `UPDATE generations
            SET status='succeeded', stored_url=?, total_tokens=?, cost_usd=?, rate_usd_per_m=?,
                error=NULL, duration_ms=?,
                params=json_set(params, '$.credits', ?, '$.tier', ?, '$.requestId', ?), updated_at=?
            WHERE id=?`,
      args: [produced.storedUrl, credits, cost, credits ? (cost / credits) * 1_000_000 : null,
             ms, credits, tier, produced.requestId, now(), job.genId],
    });
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
    await seal(job, produced);
  } catch (e) {
    await failJob(genId, (e as Error).message);
  }
}
