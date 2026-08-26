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
import { readUploadBytes } from "./storage";
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
};

export type ImageRole = "first_frame" | "last_frame" | "reference_image";

export type Reference = {
  id: string;
  mime: string;
  ext: string;
  storedUrl: string;
  role: ImageRole;
};

export type ArkStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Shape of the task payload ModelArk returns. Fields are optional: the
 *  response is thinner while a job is still queued. */
type ArkTaskResponse = {
  id?: string;
  model?: string;
  status?: string;
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
 * Turns a stored upload into the `image_url` content item ModelArk expects.
 *
 * The bytes are read back from storage and base64-encoded verbatim. Base64 is a
 * transport encoding, not a compression: the decoded bytes on ModelArk's side
 * are bit-identical to the file that was uploaded. Nothing in this path
 * resizes, re-encodes or strips anything.
 */
async function toImageContent(ref: Reference) {
  const bytes = await readUploadBytes(ref.id, ref.ext, ref.storedUrl);
  // Format token must be lowercase, e.g. data:image/png;base64,...
  const mime = ref.mime.toLowerCase();
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
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

  const content: unknown[] = [{ type: "text", text: prompt.trim() }];
  for (const ref of references) content.push(await toImageContent(ref));

  // Seedance 2.x — real JSON fields.
  const body: Record<string, unknown> = {
    model: m.id,
    content,
    ratio: p.ratio,
    resolution: p.resolution,
    duration: p.duration,
    watermark: p.watermark,
  };
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
      `Remove a reference image or use a smaller original — images are never re-compressed to fit.`
    );
  }

  const res = await fetch(TASKS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: payload,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ark submit failed (${res.status}): ${text.slice(0, 600)}`);
  }
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error(`Ark returned no task id: ${text.slice(0, 300)}`);
  return json.id;
}

export async function fetchTask(taskId: string): Promise<ArkTask> {
  const res = await fetch(`${TASKS_URL}/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ark poll failed (${res.status}): ${text.slice(0, 600)}`);
  }

  const j = JSON.parse(text) as ArkTaskResponse;
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
    raw: j,
  };
}
