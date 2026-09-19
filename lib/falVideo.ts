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
import { ASTRA_MODEL, astraInput } from "./astra";
import { falSubmit, } from "./fal";
import {
  presignedReadUrl, videoPath, imagePath, uploadPath, usingBlob,
  readImageBytes, readUploadBytes, readVideoBytes, storeVideo,
} from "./storage";
import { getModel, type ModelDef } from "./models";
import { estimateCostUsd } from "./vendorPricing";
import { type TaskDef, type TaskId } from "./tasks";
import { db, now } from "./db";
import { inspectOriginalVideo, type VideoMetadata } from "./videoMetadata.server";
import { invalidate, PROJECTS_KEY } from "./cache";
import type { Reference, VideoParams } from "./ark";
import type { Generation } from "./jobs";
import {
  writeGenerationOutcome,
  deliverGenerationSettlement,
  generationCosts,
} from "./generationSettlement";
import { creditsApply } from "./credits";
import { currentTenant, requireTenant } from "./tenant";
import { withRecoveryJob } from "./recovery";
import { billCredits, marginKeyOf } from "./creditTerms";
import { getProvider } from "./providers";
import { engineFor } from "./engines";
import { videoReferenceProblem } from "./generationReferences";

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
    if (model.id !== ASTRA_MODEL) throw new Error("Choose the supported Astra upscale engine.");
    // Astra may override its requested scale with a model-selected output size.
    // New work is quoted at the 4K tier and always names its output frame rate.
    if (!params.astra || !params.astraSource) throw new Error("Review the Astra source and output settings before submitting.");
    return {endpoint:falEndpointFor(model,"upscale",false),input:astraInput(await mediaUrl(source),params.astra,Math.min(params.astraSource.width,params.astraSource.height))};
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

  // Frames are explicit persisted choices. Ordinary references must never
  // silently change a text-to-video request into image-to-video.
  const problem = videoReferenceProblem(model, references);
  if (problem) throw new Error(problem);
  const first = images.find((r) => r.role === "first_frame") ?? null;
  const last = images.find((r) => r.role === "last_frame") ?? null;
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

async function fail(
  gen: Generation,
  message: string,
  confirmed = false,
): Promise<Generation> {
  const ts = now();
  await writeGenerationOutcome(
    {
      sql: `UPDATE generations SET status='failed', error=?, duration_ms=COALESCE(duration_ms, ?), updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled')`,
      args: [
        message.slice(0, 600),
        Math.max(0, ts - gen.createdAt),
        ts,
        gen.id,
      ],
    },
    {
      id: gen.id,
      kind: "video",
      engine: "fal",
      model: gen.model,
      status: "failed",
      engineCostUsd: confirmed && !getProvider("fal").billsFailures ? 0 : null,
      durationMs: Math.max(0, ts - gen.createdAt),
      projectId: gen.projectId,
      shotId: gen.shotId,
    },
  );
  await deliverGenerationSettlement(gen.id);
  invalidate(PROJECTS_KEY);
  return { ...gen, status: "failed", error: message, updatedAt: ts };
}

/**
 * Ask fal how a running render went and seal the row when it is done.
 * Called from every poll of the wall and from the cron; safe to call
 * again and again — nothing is charged twice, and a store that blips is
 * simply tried on the next pass.
 */
export async function syncFalVideo(
  gen: Generation,
  options: { strict?: boolean } = {},
): Promise<Generation> {
  if (gen.model !== ASTRA_MODEL) return collectFalVideo(gen, options);
  return withRecoveryJob(requireTenant().id,gen.id,async()=>{
    const until=now()+300_000;
    const claim=await db().execute({sql:`UPDATE generations SET params=json_set(params,'$.astraPollUntil',?) WHERE id=? AND kind='video' AND model=? AND deleted=0 AND status IN ('queued','running') AND json_extract(params,'$.falRequestId') IS NOT NULL AND COALESCE(json_extract(params,'$.astraPollUntil'),0) < ? RETURNING params`,args:[until,gen.id,ASTRA_MODEL,now()]});
    if(!claim.rows.length) return (await import("./jobs")).getGeneration(gen.id).then(current=>current??gen);
    try { return await collectFalVideo({...gen,params:JSON.parse(String(claim.rows[0].params))},options); }
    finally {await db().execute({sql:"UPDATE generations SET params=json_remove(params,'$.astraPollUntil') WHERE id=? AND json_extract(params,'$.astraPollUntil')=?",args:[gen.id,until]});}
  });
}
async function collectFalVideo(gen:Generation,options:{strict?:boolean}):Promise<Generation> {
  await deliverGenerationSettlement(gen.id);
  const savedCosts = await generationCosts(gen.id);
  const p = gen.params as FalVideoParams & {
    falRequestId?: string;
    falModel?: string;
    task?: string;
  };
  if (!p.falRequestId || !p.falModel) return gen;

  let polled;
  try {
    polled = await engineFor("fal").poll!({
      provider: "fal",
      ref: p.falRequestId,
      model: gen.model,
      endpoint: p.falModel,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/\b404\b|not found/i.test(msg))
      return fail(gen, "The render service no longer has this job. Render again.");
    // A refusal (422) is final; anything else gets another pass, until the ceiling.
    if (/\b422\b|refus|safety|nsfw|moderat/i.test(msg))
      return fail(gen, msg, true);
    if (now() - gen.createdAt > UNREACHABLE_CEILING_MS) {
      return fail(
        gen,
        `Could not reach the render service to find out how this render went: ${msg} If it did complete, the render service will still have charged for it.`,
      );
    }
    if (options.strict) throw e;
    return { ...gen, error: msg };
  }
  if (polled.status === "failed" || polled.status === "cancelled")
    return fail(
      gen,
      polled.error ?? "The render service could not finish this render.",
      true,
    );
  if (polled.status !== "succeeded") {
    if (now() - gen.createdAt > CEILING_MS)
      return fail(gen, "The render never came back from the render service. Render again.");
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
    if (options.strict) throw e;
    return { ...gen, error: (e as Error).message };
  }
  let cost = savedCosts.cost;
  if (cost == null)
    try {
      cost = falVideoCostUsd(getModel(gen.model).id, p);
    } catch {
      /* retain the reservation until pricing is known */
    }
  let output: VideoMetadata | undefined;
  if (gen.model === ASTRA_MODEL) {
    try {
      output=await inspectOriginalVideo({id:gen.id,kind:"video",role:"reference_video",mime:"video/mp4",ext:"mp4",storedUrl:stored.url,fromGeneration:true},stored.bytes,true);
      const delivered=falVideoCostUsd(gen.model,{...p,resolution:Math.min(output.width,output.height)<=1080?"1080p":"4k",duration:output.seconds,fps60:output.fps!>30.01});
      const quoted=falVideoCostUsd(gen.model,p);
      if(delivered==null||quoted==null||delivered>quoted+0.000001)throw new Error("Astra's delivered output exceeds the reviewed budget. The existing result is retained for reconciliation; no additional credits were charged.");
      cost=delivered;
    } catch(error) {
      const message=(error as Error).message;
      await db().execute({sql:"UPDATE generations SET error=?,updated_at=? WHERE id=? AND deleted=0 AND status IN ('queued','running')",args:[message.slice(0,600),now(),gen.id]});
      if(options.strict)throw error;
      return {...gen,error:message};
    }
  }
  const deliveredParams = output ? {astraOutput:output,astraQuotedOutput:{resolution:p.resolution,duration:p.duration,fps60:p.fps60,ratio:p.ratio},resolution:`${Math.min(output.width,output.height)}p`,ratio:`${output.width}:${output.height}`,duration:output.seconds} : undefined;
  const ts = now();
  const sealed = await writeGenerationOutcome(
    {
      sql: `UPDATE generations
          SET status='succeeded', source_url=?, stored_url=?,
              cost_usd=COALESCE(cost_usd, ?), duration_ms=COALESCE(duration_ms, ?),
              store_ms=?, bytes=?, error=NULL, updated_at=?
              ${output ? ",params=json_patch(params,json(?))" : ""}
          WHERE id=? AND deleted=0 AND status IN ('queued','running')`,
      args: [
        url,
        stored.url,
        cost,
        Math.max(0, ts - gen.createdAt),
        ts - storeStart,
        stored.bytes,
        ts,
        ...(deliveredParams ? [JSON.stringify(deliveredParams)] : []),
        gen.id,
      ],
    },
    {
      id: gen.id,
      kind: "video",
      engine: "fal",
      model: gen.model,
      status: "succeeded",
      engineCostUsd: cost != null ? cost + savedCosts.refinement : null,
      durationMs: Math.max(0, ts - gen.createdAt),
      projectId: gen.projectId,
      shotId: gen.shotId,
    },
  );
  await deliverGenerationSettlement(gen.id);
  if(!sealed) return (await import("./jobs")).getGeneration(gen.id).then(current=>current??gen);
  invalidate(PROJECTS_KEY);
  return {
    ...gen,
    params: deliveredParams ? {...gen.params,...deliveredParams} : gen.params,
    status: "succeeded",
    sourceUrl: url,
    storedUrl: stored.url,
    costUsd: creditsApply(currentTenant()?.workspace) ? null : cost,
    creditsBilled: creditsApply(currentTenant()?.workspace)
      ? billCredits(
          (cost ?? 0) + savedCosts.refinement,
          marginKeyOf(gen.kind, gen.model),
        )
      : null,
    error: null,
    updatedAt: ts,
  };
}
