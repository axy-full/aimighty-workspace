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
    // R4, same as lib/ark.ts: if a delivery copy exists, that is what is
    // sent — the vendor's ceiling decides what travels, never what we keep.
    const useDelivery = Boolean(ref.deliveryUrl);
    const bytes = await readUploadBytes(
      useDelivery ? `${ref.id}-api` : ref.id,
      useDelivery ? "jpg" : ref.ext,
      ref.deliveryUrl ?? ref.storedUrl,
    );
    input.push({
      type: "image",
      mime_type: useDelivery ? "image/jpeg" : ref.mime.toLowerCase(),
      data: bytes.toString("base64"),
    });
  }

  const body = JSON.stringify({
    model: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image",
    input,
    response_format: {
      type: "image",
      // The live API 400s on anything but image/jpeg here — JPEG is the
      // only wire format gemini-3-pro-image can return. The pixels are
      // re-wrapped losslessly into PNG at store time (see /api/generate).
      mime_type: "image/jpeg",
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
    if (res.status === 400 && /API key|api_key|invalid.*key/i.test(msg)) {
      throw new Error("Google rejected the GEMINI_API_KEY on this deployment. Check it in Vercel → Environment Variables and redeploy.");
    }
    throw new Error(`Gemini request failed (${res.status}): ${msg}`);
  }

  // Prefer the convenience field; otherwise the LAST image block across the
  // model_output steps is the final render.
  let data = j.output_image?.data ?? null;
  let mime = j.output_image?.mime_type ?? "image/jpeg";
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
    // Usually moderation. Say so plainly, keep Google's own words, and make
    // clear that a refusal costs nothing.
    throw new Error(
      "Google declined to draw this one (its safety filter). Nothing was charged — " +
      "reword the prompt or drop a reference and try again." +
      (text ? ` Google said: ${text.slice(0, 300)}` : "")
    );
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
