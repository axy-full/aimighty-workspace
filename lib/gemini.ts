import { readUploadBytes } from "./storage";
import type { Reference } from "./ark";

/**
 * Google Gemini — Nano Banana Pro (gemini-3-pro-image), via the Interactions
 * API. The only file that knows Google exists, the way lib/ark.ts is the only
 * file that knows about BytePlus.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   x-goog-api-key: $GEMINI_API_KEY
 *   { model, input: [{type:"text"...}, {type:"image", mime_type, data}...],
 *     response_format: { type:"image", mime_type, aspect_ratio, image_size } }
 *
 * Unlike Ark there is no task id to poll — the call is synchronous and the
 * model "thinks" first, so a render takes tens of seconds. The response is an
 * interaction with convenience `output_image` plus `steps` of model_output
 * content blocks; interleaved outputs put the final image LAST, so we walk
 * the steps as the fallback.
 *
 * References ride along as base64 — a transport encoding, not a compression;
 * the decoded bytes are bit-identical to what the team uploaded.
 */

/** Overridable for local stub testing, the way ARK_BASE_URL is. */
const HOST =
  process.env.GEMINI_BASE_URL?.replace(/\/$/, "") ??
  "https://generativelanguage.googleapis.com";
const URL_ = `${HOST}/v1beta/interactions`;

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new Error(
      "GEMINI_API_KEY is not set — Nano Banana Pro needs a Google Gemini API key. " +
      "Add it in Vercel → Settings → Environment Variables (and .env.local for dev), then redeploy."
    );
  }
  return k;
}

type ContentBlock = { type?: string; text?: string; data?: string; mime_type?: string };
type Step = { type?: string; content?: ContentBlock[] };
type InteractionResponse = {
  id?: string;
  output_image?: { data?: string; mime_type?: string };
  steps?: Step[];
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; code?: string | number; status?: string };
};

export type ImageResult = {
  bytes: Buffer;
  mime: string;
  /** Whatever token usage Google reported, if any. */
  totalTokens: number | null;
  /** Any text the model returned alongside (refusal reasons, notes). */
  text: string | null;
};

export async function generateImage(opts: {
  prompt: string;
  ratio: string;
  size: string;             // "1K" | "2K" | "4K" — uppercase K is mandatory
  references: Reference[];  // images only; validated upstream
}): Promise<ImageResult> {
  const input: Record<string, unknown>[] = [{ type: "text", text: opts.prompt.trim() }];
  for (const ref of opts.references) {
    const bytes = await readUploadBytes(ref.id, ref.ext, ref.storedUrl);
    input.push({
      type: "image",
      mime_type: ref.mime.toLowerCase(),
      data: bytes.toString("base64"),
    });
  }

  const body = JSON.stringify({
    model: "gemini-3-pro-image",
    input,
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: opts.ratio,
      image_size: opts.size.toUpperCase(),
    },
  });

  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
    body,
    // Pro thinks before it draws — give it room, but never hang the row.
    signal: AbortSignal.timeout(240_000),
  });

  const raw = await res.text();
  let j: InteractionResponse;
  try { j = JSON.parse(raw) as InteractionResponse; }
  catch { throw new Error(`Gemini returned non-JSON (${res.status}): ${raw.slice(0, 300)}`); }

  if (!res.ok) {
    const msg = j.error?.message ?? raw.slice(0, 400);
    throw new Error(`Gemini request failed (${res.status}): ${msg}`);
  }

  // Prefer the convenience field; otherwise the LAST image block across the
  // model_output steps is the final render.
  let data = j.output_image?.data ?? null;
  let mime = j.output_image?.mime_type ?? "image/png";
  const texts: string[] = [];
  for (const step of j.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const block of step.content ?? []) {
      if (block.type === "image" && block.data) {
        data = block.data;
        mime = block.mime_type ?? mime;
      } else if (block.type === "text" && block.text) {
        texts.push(block.text);
      }
    }
  }
  const text = texts.length ? texts.join("\n").trim() : null;

  if (!data) {
    // Usually moderation — surface the model's own words when it gave any.
    throw new Error(text ? `No image returned — the model said: ${text.slice(0, 400)}`
                         : "Gemini returned no image.");
  }

  const u = j.usage;
  const totalTokens =
    u?.total_tokens ??
    (u?.input_tokens != null || u?.output_tokens != null
      ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      : u?.prompt_tokens != null || u?.completion_tokens != null
        ? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0)
        : null);

  return { bytes: Buffer.from(data, "base64"), mime, totalTokens, text };
}
