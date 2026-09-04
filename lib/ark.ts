/**
 * The ONLY file that knows BytePlus ModelArk exists.
 * Everything else talks to these types. Swapping provider = rewriting this file.
 *
 * API shape (verified Aug 2026):
 *   POST {host}/api/v3/contents/generations/tasks   -> { id: "cgt-..." }
 *   GET  {host}/api/v3/contents/generations/tasks/{id}
 *        -> { id, model, status, content:{video_url}, usage:{total_tokens}, created_at, updated_at }
 */

import { getModel, type ModelDef } from "./models";
import { getTask, type TaskId } from "./tasks";
import { readUploadBytes, presignedReadUrl, uploadPath, videoPath, usingBlob } from "./storage";
import { IMAGE_LIMITS } from "./imagemeta";

const HOST =
  process.env.ARK_BASE_URL?.replace(/\/$/, "") ??
  "https://ark.ap-southeast.bytepluses.com";
const TASKS_URL = `${HOST}/api/v3/contents/generations/tasks`;

export type VideoParams = {
  ratio: string;
  resolution: string;
  duration: number;
  watermark: boolean;
  seed?: number | null;
  cameraFixed?: boolean;
  generateAudio?: boolean;
  /** generate | edit | extend — decides which parameters we're allowed to set. */
  task?: TaskId;
  /** Container to ask the vendor for. See the note in buildRequestBody. */
  outputFormat?: "mp4" | "mov";
};

export type ImageRole = "first_frame" | "last_frame" | "reference_image" | "reference_video";

export type Reference = {
  id: string;
  mime: string;
  ext: string;
  storedUrl: string;
  role: ImageRole;
  kind: "image" | "video";
  /** Set when the master was too large or too extreme for this vendor and a
   *  delivery copy was derived at upload time. The master is never sent. */
  deliveryUrl?: string | null;
  /** True when this is one of OUR renders being edited or extended: the bytes
   *  live under generations/, not uploads/, so it presigns from a different
   *  path. */
  fromGeneration?: boolean;
};

export type ArkStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Shape of the task payload ModelArk returns. Fields are optional: the
 *  response is thinner while a job is still queued. */
type ArkTaskResponse = {
  id?: string;
  model?: string;
  status?: string;
  /* ModelArk stamps its tasks in Unix SECONDS. Optional because it is their
     field, not our contract: when it is absent we fall back to measuring
     from our own submit, which folds their queue time into the engine time
     but never invents a number. */
  created_at?: number;
  updated_at?: number;
  content?: { video_url?: string | null };
  usage?: { total_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
};

export type ArkTask = {
  id: string;
  model: string;
  status: ArkStatus;
  videoUrl: string | null;
  totalTokens: number | null;
  error: string | null;
  /** The vendor's own clock, in ms, when it reports one. */
  vendorStartedAt: number | null;
  vendorEndedAt: number | null;
  raw: unknown;
};

function apiKey(): string {
  const k = process.env.ARK_API_KEY;
  if (!k) throw new Error("ARK_API_KEY is not set. Add it to .env.local");
  return k;
}

/** Seedance 1.x wants settings glued onto the prompt as --flags. */
function buildFlagText(prompt: string, p: VideoParams, m: ModelDef): string {
  const flags = [
    `--ratio ${p.ratio}`,
    `--resolution ${p.resolution}`,
    `--duration ${p.duration}`,
    `--watermark ${p.watermark}`,
  ];
  if (m.supportsCameraFixed) flags.push(`--camerafixed ${p.cameraFixed ?? false}`);
  if (p.seed != null) flags.push(`--seed ${p.seed}`);
  return `${prompt.trim()} ${flags.join(" ")}`;
}

/**
 * Turns a stored upload into the content item ModelArk expects.
 *
 * In production the URL is a time-limited presigned GET on the private blob —
 * ModelArk fetches the exact stored bytes, nothing is made public, and
 * reference videos (which accept ONLY a URL, never base64) work. Local dev
 * has no presignable storage, so images fall back to base64 — a transport
 * encoding, not a compression; the decoded bytes are bit-identical.
 */
async function toRefContent(ref: Reference) {
  if (ref.kind === "video") {
    if (!usingBlob()) {
      throw new Error(
        ref.fromGeneration
          ? "Editing and extension need the deployed workspace — ModelArk fetches the source video by URL, which local storage can't provide."
          : "Reference videos need the deployed workspace — ModelArk fetches them by URL, which local storage can't provide."
      );
    }
    // Editing and extension point at a render we already hold, which lives
    // under generations/ rather than uploads/.
    const path = ref.fromGeneration ? videoPath(ref.id) : uploadPath(ref.id, ref.ext);
    const url = await presignedReadUrl(path);
    return { type: "video_url", video_url: { url }, role: "reference_video" };
  }

  /* R4: if a delivery copy exists, that is what travels. The master stays
   * where it is — the vendor's ceiling decides what we SEND, never what we
   * keep. Derivatives are always JPEG (see lib/derive.ts). */
  const useDelivery = Boolean(ref.deliveryUrl);
  const sendId = useDelivery ? `${ref.id}-api` : ref.id;
  const sendExt = useDelivery ? "jpg" : ref.ext;
  const sendMime = useDelivery ? "image/jpeg" : ref.mime.toLowerCase();

  if (usingBlob()) {
    const url = await presignedReadUrl(uploadPath(sendId, sendExt));
    return { type: "image_url", image_url: { url }, role: ref.role };
  }
  const bytes = await readUploadBytes(sendId, sendExt, ref.deliveryUrl ?? ref.storedUrl);
  // Format token must be lowercase, e.g. data:image/png;base64,...
  return {
    type: "image_url",
    image_url: { url: `data:${sendMime};base64,${bytes.toString("base64")}` },
    role: ref.role,
  };
}

export async function buildRequestBody(
  modelId: string,
  prompt: string,
  p: VideoParams,
  references: Reference[] = []
): Promise<Record<string, unknown>> {
  const m = getModel(modelId);

  if (m.paramStyle === "flags") {
    return {
      model: m.id,
      content: [{ type: "text", text: buildFlagText(prompt, p, m) }],
    };
  }

  // Text first, then images, then videos — @ImageN / @VideoN indices count
  // within their own kind, in the order the user arranged.
  const content: unknown[] = [{ type: "text", text: prompt.trim() }];
  for (const ref of references.filter((r) => r.kind === "image")) content.push(await toRefContent(ref));
  for (const ref of references.filter((r) => r.kind === "video")) content.push(await toRefContent(ref));

  /* Seedance 2.x — real JSON fields.
   *
   * A LOCKED task (edit, extend) hands the output's shape to the source
   * video, and the API expects to be TOLD that: ratio "adaptive" for both,
   * and duration -1 for an edit, whose length follows the source. Sending a
   * concrete ratio or duration on a locked task is a rejected or wrongly
   * shaped render, so these overrides are applied here rather than trusted
   * to the caller. See lib/tasks.ts for the rules and their source. */
  const task = getTask(p.task ?? "generate");
  const body: Record<string, unknown> = {
    model: m.id,
    content,
    ratio: task.forceRatio ?? p.ratio,
    resolution: p.resolution,
    duration: task.forceDuration ?? p.duration,
    watermark: p.watermark,
  };
  /* ByteDance recommend mov for edits and extensions — it preserves colour
   * and audio-visual continuity that an mp4 re-encode degrades. We do NOT
   * default to it, deliberately: a QuickTime container does not play
   * reliably in Chrome, and every render in this workspace is watched in a
   * browser, so defaulting to mov would trade a visible library for an
   * invisible improvement. It is a workspace setting; when it is on, the
   * storage and media layers serve the right container. */
  if (p.outputFormat === "mov") body.output_format = "mov";
  void task.preferMov;   // the vendor's advice, recorded in lib/tasks.ts
  if (p.seed != null) body.seed = p.seed;
  if (m.supportsAudio) body.generate_audio = Boolean(p.generateAudio);
  return body;
}

export async function submitTask(
  modelId: string,
  prompt: string,
  p: VideoParams,
  references: Reference[] = []
): Promise<string> {
  const payload = JSON.stringify(await buildRequestBody(modelId, prompt, p, references));

  // ModelArk caps the whole JSON body at 64MB. We never shrink an image to fit —
  // if it doesn't fit, that is reported rather than silently degraded.
  const size = Buffer.byteLength(payload, "utf8");
  if (size > IMAGE_LIMITS.maxRequestBytes) {
    throw new Error(
      `Request body is ${(size / 1048576).toFixed(1)} MB, over ModelArk's 64 MB limit. ` +
      `Remove a reference or use a smaller original — media is never re-compressed to fit.`
    );
  }

  const res = await arkFetch(TASKS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: payload,
  }, 120_000);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ark submit failed (${res.status}): ${text.slice(0, 600)}`);
  }
  const json = parseArk<{ id?: string }>(text, "submit");
  if (!json.id) throw new Error(`Ark returned no task id: ${text.slice(0, 300)}`);
  return json.id;
}

/**
 * One fetch to ModelArk, with a deadline. A submit carries a large body and
 * is given longer than a poll; neither is allowed to hang until the
 * function's own five-minute ceiling.
 */
async function arkFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(`ModelArk did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new Error(`Could not reach ModelArk: ${err.message}`);
  }
}

/**
 * Their body is JSON until the day it isn't — a gateway 502 arrives as an
 * HTML page, and a bare JSON.parse turns that into "Unexpected token <",
 * which tells nobody anything.
 */
function parseArk<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ModelArk sent an unreadable ${what} response: ${text.slice(0, 200)}`);
  }
}

/** A vendor Unix-seconds stamp, in ms, or null if it is missing or absurd. */
function sane(sec: number | undefined): number | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  const ms = sec * 1000;
  // Anything before 2020 or more than a day ahead is not a real task stamp.
  if (ms < 1577836800000 || ms > Date.now() + 86400000) return null;
  return ms;
}

export async function fetchTask(taskId: string): Promise<ArkTask> {
  const res = await arkFetch(`${TASKS_URL}/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    cache: "no-store",
  }, 30_000);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ark poll failed (${res.status}): ${text.slice(0, 600)}`);
  }

  const j = parseArk<ArkTaskResponse>(text, "poll");
  const rawStatus = String(j.status ?? "queued").toLowerCase();
  const status: ArkStatus = (
    ["queued", "running", "succeeded", "failed", "cancelled"].includes(rawStatus)
      ? rawStatus
      : rawStatus === "processing" || rawStatus === "in_progress"
        ? "running"
        : rawStatus === "success"
          ? "succeeded"
          : "queued"
  ) as ArkStatus;

  return {
    id: String(j.id ?? taskId),
    model: String(j.model ?? ""),
    status,
    videoUrl: j.content?.video_url ?? null,
    // BytePlus bills on completion_tokens — prefer it over total_tokens.
    totalTokens: j.usage?.completion_tokens ?? j.usage?.total_tokens ?? null,
    error: j.error?.message ?? j.error?.code ?? null,
    // Seconds on their side, milliseconds on ours. Guarded: a zero or a
    // wildly out-of-range value is treated as absent rather than trusted.
    vendorStartedAt: sane(j.created_at),
    vendorEndedAt: sane(j.updated_at),
    raw: j,
  };
}
