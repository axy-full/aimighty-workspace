/**
 * Video on fal.ai — Kling 3.0 (text-to-video, image-to-video, motion
 * control) and Topaz Astra (creative upscale) — on the same rows, ledgers
 * and polling as a Seedance render.
 *
 * The shape is ModelArk's: the row goes in first, the vendor's handle is
 * written to it, and a sync finishes the render from that handle whether
 * the poll comes from an open wall or from the cron an hour later. fal
 * holds the job on a durable queue, so the request id IS the render — the
 * same discipline lib/identities.ts uses for portrait stills.
 *
 * Prices are per second of output (lib/models.ts secondRates), so the cost
 * is known before the render and sealed from the row's own params after —
 * there is no token count to wait for.
 */
import { falSubmit, } from "./fal";
import {
  presignedReadUrl, videoPath, imagePath, uploadPath, usingBlob,
  readImageBytes, readUploadBytes, readVideoBytes, storeVideo,
} from "./storage";
import { getModel, type ModelDef } from "./models";
import { estimateCostUsd } from "./vendorPricing";
import { type TaskDef, type TaskId } from "./tasks";
import { db, now } from "./db";
import { invalidate, PROJECTS_KEY } from "./cache";
import type { Reference, VideoParams } from "./ark";
import type { Generation } from "./jobs";
import { meter } from "./meter";
import { getProvider } from "./providers";
import { engineFor } from "./engines";

/** A render still "running" past this has been abandoned by the vendor. */
const CEILING_MS = 60 * 60_000;
/** Past this, a job we cannot even ask about is given up on. */
const UNREACHABLE_CEILING_MS = 6 * 60 * 60_000;

/** The exact fal endpoint a render goes to. */
export function falEndpointFor(model: ModelDef, task: TaskId, hasStartImage: boolean): string {
  const base = model.falEndpoint ?? model.id;
  if (task === "upscale" || task === "reframe") return base;
  if (task === "motion") return `${base}/motion-control`;
  return `${base}/${hasStartImage ? "image-to-video" : "text-to-video"}`;
}

/**
 * Where fal fetches an input from. On Vercel a time-limited presigned GET
 * on the private blob; locally, with nothing presignable, the bytes go
 * inline as a data URI (a transport encoding, bit-identical).
 */
export async function mediaUrl(ref: Reference): Promise<string> {
  if (ref.kind === "video") {
    if (usingBlob()) return presignedReadUrl(ref.fromGeneration ? videoPath(ref.id) : uploadPath(ref.id, ref.ext));
    const bytes = ref.fromGeneration ? await readVideoBytes(ref.id) : await readUploadBytes(ref.id, ref.ext, ref.storedUrl);
    return `data:video/mp4;base64,${bytes.toString("base64")}`;
  }
  if (ref.fromGeneration) {
    if (usingBlob()) return presignedReadUrl(imagePath(ref.id));
    return `data:image/png;base64,${(await readImageBytes(ref.id)).toString("base64")}`;
  }
  // A delivery copy, when one exists, is what travels (see lib/ark.ts).
  const useDelivery = Boolean(ref.deliveryUrl);
  const sendId = useDelivery ? `${ref.id}-api` : ref.id;
  const sendExt = useDelivery ? "jpg" : ref.ext;
  if (usingBlob()) return presignedReadUrl(uploadPath(sendId, sendExt));
  const bytes = await readUploadBytes(sendId, sendExt, ref.deliveryUrl ?? ref.storedUrl);
  return `data:${useDelivery ? "image/jpeg" : ref.mime.toLowerCase()};base64,${bytes.toString("base64")}`;
}

export type FalVideoParams = VideoParams & {
  characterOrientation?: "image" | "video";
  fps60?: boolean;
  sourceResolution?: string;
};

/** The vendor's input for one render, by task. */
export async function buildFalInput(opts: {
  model: ModelDef; task: TaskDef; prompt: string; params: FalVideoParams;
  references: Reference[]; source: Reference | null;
}): Promise<{ endpoint: string; input: Record<string, unknown> }> {
  const { model, task, prompt, params, references, source } = opts;
  const images = references.filter((r) => r.kind === "image");

  if (task.id === "upscale") {
    if (!source) throw new Error("Upscale needs a finished clip to work on.");
    /* Astra prices by OUTPUT resolution, so the factor is whatever gets the
       source's short side to the tier chosen — never past fal's 4×. */
    const target = params.resolution.toLowerCase() === "4k" ? 2160 : 1080;
    const srcPx = Number(String(params.sourceResolution ?? "720p").replace(/p$/i, "")) || 720;
    const factor = Math.min(4, Math.max(1, Math.round((target / srcPx) * 100) / 100));
    return {
      endpoint: falEndpointFor(model, "upscale", false),
      input: {
        video_url: await mediaUrl(source),
        upscale_factor: factor, creativity: 0.5, sharp: 0.5,
        ...(params.fps60 ? { target_fps: 60 } : {}),
        H264_output: true,
      },
    };
  }

  if (task.id === "reframe") {
    if (!source) throw new Error("Reframe needs a finished clip to re-cut.");
    const ratio = model.ratios.includes(params.ratio) ? params.ratio : "9:16";
    return {
      endpoint: falEndpointFor(model, "reframe", false),
      input: {
        video_url: await mediaUrl(source),
        aspect_ratio: ratio,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      },
    };
  }

  if (task.id === "motion") {
    if (!source) throw new Error("Motion control needs the clip whose movement to borrow.");
    const face = images[0];
    if (!face) throw new Error("Motion control needs a still of the character — attach one.");
    return {
      endpoint: falEndpointFor(model, "motion", false),
      input: {
        image_url: await mediaUrl(face),
        video_url: await mediaUrl(source),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        character_orientation: params.characterOrientation === "image" ? "image" : "video",
        keep_original_sound: Boolean(params.generateAudio),
      },
    };
  }

  /* Generate: text-to-video, or image-to-video the moment a frame is
     attached — a first frame, and a second image as the last frame. */
  const first = images.find((r) => r.role === "first_frame") ?? images[0] ?? null;
  const last = images.find((r) => r.role === "last_frame" && r !== first)
    ?? (first ? images.find((r) => r !== first) ?? null : null);
  const input: Record<string, unknown> = {
    prompt: prompt.trim(),
    duration: String(params.duration),
    generate_audio: Boolean(params.generateAudio),
    negative_prompt: "blur, distort, and low quality",
    cfg_scale: 0.5,
  };
  if (first) {
    input.start_image_url = await mediaUrl(first);
    if (last) input.end_image_url = await mediaUrl(last);
  } else {
    input.aspect_ratio = ["16:9", "9:16", "1:1"].includes(params.ratio) ? params.ratio : "16:9";
  }
  return { endpoint: falEndpointFor(model, "generate", Boolean(first)), input };
}

/** Put the render on fal's queue. The request id is what the row keeps. */
export async function submitFalVideo(opts: Parameters<typeof buildFalInput>[0]): Promise<{ requestId: string; endpoint: string }> {
  const { endpoint, input } = await buildFalInput(opts);
  const queued = await falSubmit(endpoint, input);
  return { requestId: queued.request_id, endpoint };
}

/** What a finished fal render cost, from the row's own params: seconds × the rate. */
export function falVideoCostUsd(modelId: string, p: FalVideoParams & { task?: string }): number | null {
  const est = estimateCostUsd(modelId, String(p.resolution ?? "1080p"), String(p.ratio ?? "16:9"), Number(p.duration ?? 0), 0, false, {
    audio: Boolean(p.generateAudio), task: p.task as TaskId | undefined, fps60: Boolean(p.fps60),
  });
  return est ? est.net : null;
}

async function fail(gen: Generation, message: string): Promise<Generation> {
  const ts = now();
  await db().execute({
    sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms, ?), updated_at=? WHERE id=?`,
    args: [message.slice(0, 600), Math.max(0, ts - gen.createdAt), ts, gen.id],
  }).catch(() => {});
  invalidate(PROJECTS_KEY);
  await meter({ id: gen.id, kind: "video", engine: "fal", model: gen.model, status: "failed",
                engineCostUsd: getProvider("fal").billsFailures ? null : 0, durationMs: Math.max(0, ts - gen.createdAt),
                projectId: gen.projectId, shotId: gen.shotId }, { critical: false }).catch(() => {});
  return { ...gen, status: "failed", error: message, updatedAt: ts };
}

/**
 * Ask fal how a running render went and seal the row when it is done.
 * Called from every poll of the wall and from the cron; safe to call
 * again and again — nothing is charged twice, and a store that blips is
 * simply tried on the next pass.
 */
export async function syncFalVideo(gen: Generation): Promise<Generation> {
  const p = gen.params as FalVideoParams & { falRequestId?: string; falModel?: string; task?: string };
  if (!p.falRequestId || !p.falModel) return gen;

  let polled;
  try {
    polled = await engineFor("fal").poll!({ provider: "fal", ref: p.falRequestId, model: gen.model, endpoint: p.falModel });
  } catch (e) {
    const msg = (e as Error).message;
    if (/\b404\b|not found/i.test(msg)) return fail(gen, "fal.ai no longer has this job. Render again.");
    // A refusal (422) is final; anything else gets another pass, until the ceiling.
    if (/\b422\b|refus|safety|nsfw|moderat/i.test(msg)) return fail(gen, msg);
    if (now() - gen.createdAt > UNREACHABLE_CEILING_MS) {
      return fail(gen, `Could not reach fal.ai to find out how this render went: ${msg} If it did complete, fal will still have charged for it.`);
    }
    return { ...gen, error: msg };
  }
  if (polled.status === "failed") return fail(gen, polled.error ?? "fal.ai could not finish this render.");
  if (polled.status !== "succeeded") {
    if (now() - gen.createdAt > CEILING_MS) return fail(gen, "The render never came back from fal.ai. Render again.");
    return gen;
  }
  const url = polled.videoUrl!;

  const storeStart = now();
  let stored: { url: string; bytes: number };
  try {
    stored = await storeVideo(gen.id, url);
  } catch (e) {
    // fal's URL lives for a while; the next pass stores it. Loud, though.
    console.error(`storeVideo failed for ${gen.id}:`, (e as Error).message);
    return { ...gen, error: (e as Error).message };
  }
  let cost: number | null = null;
  try { cost = falVideoCostUsd(getModel(gen.model).id, p); } catch { cost = null; }
  const ts = now();
  await db().execute({
    sql: `UPDATE generations
          SET status='succeeded', source_url=?, stored_url=?,
              cost_usd=COALESCE(cost_usd, ?), duration_ms=COALESCE(duration_ms, ?),
              store_ms=?, bytes=?, error=NULL, updated_at=?
          WHERE id=?`,
    args: [url, stored.url, cost, Math.max(0, ts - gen.createdAt), ts - storeStart, stored.bytes, ts, gen.id],
  });
  invalidate(PROJECTS_KEY);
  await meter({ id: gen.id, kind: "video", engine: "fal", model: gen.model, status: "succeeded",
                engineCostUsd: cost != null ? cost + (gen.refineCostUsd ?? 0) : null, durationMs: Math.max(0, ts - gen.createdAt),
                projectId: gen.projectId, shotId: gen.shotId }, { critical: false });
  return { ...gen, status: "succeeded", sourceUrl: url, storedUrl: stored.url, costUsd: cost ?? gen.costUsd, error: null, updatedAt: ts };
}
