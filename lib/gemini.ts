import { readUploadBytes } from "./storage";
import type { Reference } from "./ark";
import type { ModelDef } from "./models";
import { gatewayReachable, gatewayAuth, GATEWAY_URL, explainGatewayFailure } from "./gateway";

/**
 * Google's still engines — Nano Banana Pro and Nano Banana 2 — through one
 * of two doors:
 *
 *   gateway — Vercel AI Gateway's OpenAI-compatible chat completions, with
 *             `modalities: ["image","text"]` and the aspect and size under
 *             `providerOptions.google.imageConfig` (verified live: 1:1 at
 *             1K came back 1024×1024). The image arrives as a data URL in
 *             `message.images[0]`, and `usage.cost` is the exact charge.
 *             Reached with the deployment's own identity; bills to the
 *             same credit as the prompt writer. The default whenever it is
 *             reachable.
 *   google  — Google's Interactions API on a GEMINI_API_KEY, the original
 *             door; kept as the fallback, or forced with STILLS_VIA=google.
 *
 * Either way the call is synchronous and the model thinks before it draws,
 * so a render takes tens of seconds. References ride along as base64 — a
 * transport encoding, not a compression; the decoded bytes are bit-identical
 * to what was uploaded (or to the delivery copy, when one exists).
 */

const GOOGLE_HOST =
  process.env.GEMINI_BASE_URL?.replace(/\/$/, "") ?? "https://generativelanguage.googleapis.com";

export type ImageResult = {
  bytes: Buffer;
  mime: string;
  /** Whatever token usage the vendor reported, if any. */
  totalTokens: number | null;
  /** The exact charge, when the vendor states one (the gateway does). */
  costUsd: number | null;
  /** Any text the model returned alongside (refusal reasons, notes). */
  text: string | null;
  via: "gateway" | "google";
};

export function stillsDoor(): "gateway" | "google" | null {
  const key = Boolean(process.env.GEMINI_API_KEY);
  if (process.env.STILLS_VIA === "google" && key) return "google";
  if (gatewayReachable()) return "gateway";
  return key ? "google" : null;
}

/** A reference as the vendor should receive it: the delivery copy if there is one. */
async function refPayload(ref: Reference): Promise<{ mime: string; b64: string }> {
  const useDelivery = Boolean(ref.deliveryUrl);
  const bytes = await readUploadBytes(
    useDelivery ? `${ref.id}-api` : ref.id,
    useDelivery ? "jpg" : ref.ext,
    ref.deliveryUrl ?? ref.storedUrl,
  );
  return { mime: useDelivery ? "image/jpeg" : ref.mime.toLowerCase(), b64: bytes.toString("base64") };
}

function refusal(text: string | null): Error {
  return new Error(
    "Google's built-in image filter declined this one. The adjustable safety " +
    "thresholds are already off, so this is the layer no setting turns off. " +
    "Nothing was charged — reword the prompt or drop a reference and try again." +
    (text ? ` Google said: ${text.slice(0, 300)}` : "")
  );
}

/* ── Safety thresholds ──────────────────────────────────────────────────
 * Google's four adjustable categories are sent explicitly at OFF, so a
 * prompt is never held back by the probability classifiers — the team's
 * shots are judged by the one filter Google keeps for itself. Google's own
 * default for Gemini 2.5/3 models is already Off when nothing is sent;
 * saying so on every request keeps that true if their default moves.
 * GOOGLE_SAFETY_THRESHOLD overrides (BLOCK_NONE, BLOCK_ONLY_HIGH,
 * BLOCK_MEDIUM_AND_ABOVE, BLOCK_LOW_AND_ABOVE, or "default" to send none).
 * ------------------------------------------------------------------- */
export const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

export function safetyThreshold(): string | null {
  const t = (process.env.GOOGLE_SAFETY_THRESHOLD ?? "OFF").trim().toUpperCase();
  if (t === "DEFAULT" || t === "") return null;
  return ["OFF", "BLOCK_NONE", "BLOCK_ONLY_HIGH", "BLOCK_MEDIUM_AND_ABOVE", "BLOCK_LOW_AND_ABOVE"].includes(t) ? t : "OFF";
}

export function safetySettings(): { category: string; threshold: string }[] | null {
  const threshold = safetyThreshold();
  return threshold ? SAFETY_CATEGORIES.map((category) => ({ category, threshold })) : null;
}

export async function generateImage(opts: {
  model: ModelDef;
  prompt: string;
  ratio: string;
  size: string;             // "512" | "1K" | "2K" | "4K" — uppercase K is mandatory
  references: Reference[];  // images only; validated upstream
}): Promise<ImageResult> {
  const door = stillsDoor();
  if (!door) {
    throw new Error(
      `${opts.model.label} needs a door to Google: run on Vercel (or set AI_GATEWAY_API_KEY) ` +
      "for the gateway, or set GEMINI_API_KEY for Google directly."
    );
  }
  return door === "gateway" ? viaGateway(opts) : viaGoogle(opts);
}

/* ── Door 1: Vercel AI Gateway ─────────────────────────────────────────── */

async function viaGateway(opts: {
  model: ModelDef; prompt: string; ratio: string; size: string; references: Reference[];
}): Promise<ImageResult> {
  const modelId = opts.model.gatewayId ?? `google/${opts.model.id}`;
  const auth = await gatewayAuth();
  const content: Record<string, unknown>[] = [{ type: "text", text: opts.prompt.trim() }];
  for (const ref of opts.references) {
    const { mime, b64 } = await refPayload(ref);
    content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
  }
  const imageConfig = { aspectRatio: opts.ratio, imageSize: opts.size.toUpperCase() };
  const safety = safetySettings();
  const bodyFor = (withSafety: boolean) => {
    const google: Record<string, unknown> = { imageConfig };
    if (withSafety && safety) google.safetySettings = safety;
    return JSON.stringify({
      model: modelId,
      max_tokens: 8192,
      modalities: ["image", "text"],
      // The gateway routes Google models through either door; the config is
      // read under whichever namespace the serving provider uses.
      providerOptions: { google, vertex: { ...google } },
      messages: [{ role: "user", content }],
    });
  };

  const send = (body: string) => fetch(GATEWAY_URL(), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(240_000),
  });
  let res = await send(bodyFor(true));
  let raw = await res.text();
  // Should the gateway ever refuse the safety block itself, the render must
  // not die for it: send once more the way it went before the block existed.
  if (res.status === 400 && safety && /safety/i.test(raw)) {
    res = await send(bodyFor(false));
    raw = await res.text();
  }
  if (!res.ok) {
    const plain = explainGatewayFailure(res.status, raw);
    if (plain) throw new Error(plain);
    let msg = raw.slice(0, 400);
    try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* raw */ }
    throw new Error(`Gateway image request failed (${res.status}): ${msg}`);
  }
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let j: any;
  try { j = JSON.parse(raw); }
  catch { throw new Error(`Gateway returned non-JSON: ${raw.slice(0, 300)}`); }

  const msg = j.choices?.[0]?.message ?? {};
  const images: { image_url?: { url?: string } }[] = Array.isArray(msg.images) ? msg.images : [];
  const url: string | undefined = images[0]?.image_url?.url;
  const text: string | null =
    typeof msg.content === "string" && msg.content.trim() ? msg.content.trim() : null;
  if (!url || !url.startsWith("data:")) throw refusal(text);

  const comma = url.indexOf(",");
  const mime = url.slice(5, url.indexOf(";")) || "image/jpeg";
  const bytes = Buffer.from(url.slice(comma + 1), "base64");
  const u = j.usage ?? {};
  return {
    bytes, mime, text, via: "gateway",
    totalTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : null,
    costUsd: typeof u.cost === "number" ? u.cost : null,
  };
}

/* ── Door 2: Google directly ───────────────────────────────────────────── */

type ContentBlock = { type?: string; text?: string; data?: string; mime_type?: string };
type Step = { type?: string; content?: ContentBlock[] };
type InteractionResponse = {
  id?: string;
  output_image?: { data?: string; mime_type?: string };
  steps?: Step[];
  usage?: {
    total_tokens?: number; input_tokens?: number; output_tokens?: number;
    prompt_tokens?: number; completion_tokens?: number;
  };
  error?: { message?: string; code?: string | number; status?: string };
};

async function viaGoogle(opts: {
  model: ModelDef; prompt: string; ratio: string; size: string; references: Reference[];
}): Promise<ImageResult> {
  const key = process.env.GEMINI_API_KEY!;
  const input: Record<string, unknown>[] = [{ type: "text", text: opts.prompt.trim() }];
  for (const ref of opts.references) {
    const { mime, b64 } = await refPayload(ref);
    input.push({ type: "image", mime_type: mime, data: b64 });
  }
  const body = JSON.stringify({
    model: process.env.GEMINI_IMAGE_MODEL ?? opts.model.id,
    input,
    response_format: {
      type: "image",
      // The live API 400s on anything but image/jpeg here — JPEG is the only
      // wire format this door can return. The pixels are re-wrapped
      // losslessly into PNG at store time (see /api/generate).
      mime_type: "image/jpeg",
      aspect_ratio: opts.ratio,
      image_size: opts.size.toUpperCase(),
    },
  });

  const res = await fetch(`${GOOGLE_HOST}/v1beta/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body,
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
      if (block.type === "image" && block.data) { data = block.data; mime = block.mime_type ?? mime; }
      else if (block.type === "text" && block.text) texts.push(block.text);
    }
  }
  const text = texts.length ? texts.join("\n").trim() : null;
  if (!data) throw refusal(text);

  const u = j.usage;
  const totalTokens =
    u?.total_tokens ??
    (u?.input_tokens != null || u?.output_tokens != null
      ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      : u?.prompt_tokens != null || u?.completion_tokens != null
        ? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0)
        : null);
  return { bytes: Buffer.from(data, "base64"), mime, totalTokens, costUsd: null, text, via: "google" };
}
