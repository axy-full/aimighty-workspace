import { generateImage, type ImageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createGateway } from "@ai-sdk/gateway";
import type { ModelDef } from "./models";
import type { Reference } from "./ark";
import { refPayload } from "./gemini";
import { gatewayAuth, GATEWAY_BASE } from "./gateway";
import { vendorKey } from "./vendorKeys";
import { billedTo } from "./providers";
import { estimateImageCostUsd } from "./vendorPricing";
import { openAIImageFetch } from "./openai-direct";
import { recoveryFetch } from "./recovery";
import { engineMock } from "./mock";
import { fixtureBytes } from "./mockFs";

/**
 * OpenAI's GPT Image and xAI's Grok Imagine stills (owner, 23 September).
 * Each goes straight to its vendor on the vendor's key and bills as that
 * vendor's charge; with no key it goes through the AI Gateway and bills as
 * gateway credit — the same door the ledger records (billedTo). No fallback
 * between doors after a failure: the ledger must say who actually charged.
 */
export type VendorStill = { bytes: Buffer; mime: string; costUsd: number | null; totalTokens: number | null; via: "openai" | "xai" | "gateway" };

/** GPT Image's per-token list rates (USD), for pricing a direct call from its usage. */
const OPENAI_TOKEN_USD: Record<string, { input: number; output: number }> = {
  "gpt-image-2": { input: 10e-6, output: 30e-6 },
  "gpt-image-2.5-flare": { input: 10e-6, output: 30e-6 },
  "gpt-image-2.5-sunburst": { input: 10e-6, output: 30e-6 },
  "gpt-image-1.5": { input: 10e-6, output: 32e-6 },
  "gpt-image-1": { input: 10e-6, output: 40e-6 },
  "gpt-image-1-mini": { input: 2.5e-6, output: 8e-6 },
};

/** Fixed sizes for the older GPT Image models; about 1.5 MP in multiples of 16 for the flexible ones. */
const FIXED_SIZES: Record<string, `${number}x${number}`> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
const FLEXIBLE_SIZES: Record<string, `${number}x${number}`> = {
  "1:1": "1248x1248", "16:9": "1664x928", "9:16": "928x1664", "4:3": "1440x1072", "3:4": "1072x1440",
  "3:2": "1536x1024", "2:3": "1024x1536", "21:9": "1904x816",
};
export function openAISize(model: ModelDef, ratio: string): `${number}x${number}` {
  const flexible = model.ratios.includes("16:9");
  const size = (flexible ? FLEXIBLE_SIZES : FIXED_SIZES)[ratio];
  if (!size) throw new Error(`${model.label} does not make ${ratio} stills.`);
  return size;
}

/**
 * A vendor's reported charge is used only when it is a sane figure next to
 * the quote (at most three times it); otherwise the quote stands, so a unit
 * mistake can never bill ten times over.
 */
function sane(cost: number | null | undefined, estimate: number, floor = 0): number | null {
  return typeof cost === "number" && Number.isFinite(cost) && cost >= estimate * floor && estimate > 0 && cost <= estimate * 3 ? cost : null;
}
function metaNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

async function gatewayImageModel(id: string): Promise<ImageModel> {
  const auth = await gatewayAuth();
  const token = auth.Authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("The model gateway is not connected for this workspace.");
  const gateway = createGateway({ apiKey: token, headers: { ...auth, "ai-gateway-auth-method": vendorKey("gateway") ? "api-key" : "oidc" }, baseURL: new URL("/v4/ai", GATEWAY_BASE()).href, fetch: recoveryFetch });
  return gateway.imageModel(id);
}

export async function vendorStill(opts: { model: ModelDef; prompt: string; ratio: string; size: string; references: Reference[] }): Promise<VendorStill> {
  const { model } = opts;
  const vendor = model.provider as "openai" | "xai";
  const estimate = estimateImageCostUsd(model.id, opts.size, opts.references.length)?.net ?? 0;
  if (engineMock()) return { bytes: await fixtureBytes("still.png"), mime: "image/png", totalTokens: null, costUsd: estimate, via: billedTo(vendor) === "vercel" ? "gateway" : vendor };
  const door = billedTo(vendor) === "vercel" ? "gateway" : vendor;
  const images = await Promise.all(opts.references.map(async (ref) => { const { mime, b64 } = await refPayload(ref); return `data:${mime};base64,${b64}`; }));
  const prompt = images.length ? { text: opts.prompt.trim(), images } : opts.prompt.trim();
  const quality = opts.size.toLowerCase();

  let imageModel: ImageModel;
  let xaiTicks: number | null = null;
  const settings: Parameters<typeof generateImage>[0] extends infer T ? Partial<T> : never = {};
  if (vendor === "openai") {
    Object.assign(settings, { size: openAISize(model, opts.ratio), providerOptions: { openai: { quality } } });
    if (door === "openai") {
      const key = vendorKey("openai");
      if (!key) throw new Error("The OpenAI account is not connected for this workspace.");
      imageModel = createOpenAI({ apiKey: key, fetch: openAIImageFetch(recoveryFetch) }).image(model.id);
    } else imageModel = await gatewayImageModel(model.gatewayId!);
  } else {
    Object.assign(settings, { aspectRatio: opts.ratio as `${number}:${number}`, providerOptions: { xai: { resolution: opts.size.toLowerCase() }, spacexai: { resolution: opts.size.toLowerCase() } } });
    if (door === "xai") {
      const key = vendorKey("xai");
      if (!key) throw new Error("The xAI account is not connected for this workspace.");
      /* generateImage keeps only per-image metadata from a vendor, so xAI's
         charge (usage.cost_in_usd_ticks) is read off the call itself. */
      const inner = createXai({ apiKey: key, fetch: recoveryFetch }).image(model.id);
      imageModel = new Proxy(inner, { get(target, prop, receiver) {
        if (prop !== "doGenerate") return Reflect.get(target, prop, receiver);
        return async (options: Parameters<typeof inner.doGenerate>[0]) => {
          const out = await target.doGenerate(options);
          xaiTicks = metaNumber((out.providerMetadata?.xai as Record<string, unknown> | undefined)?.costInUsdTicks);
          return out;
        };
      } });
    } else imageModel = await gatewayImageModel(model.gatewayId!);
  }

  const result = await generateImage({ model: imageModel, prompt, n: 1, maxRetries: 0, abortSignal: AbortSignal.timeout(240_000), ...settings });
  const image = result.images[0];
  if (!image) throw new Error(`${model.label} returned no image.`);
  const usage = result.usage;
  const totalTokens = usage?.totalTokens ?? null;
  let reported: number | null = null;
  if (door === "gateway") reported = metaNumber((result.providerMetadata?.gateway as Record<string, unknown> | undefined)?.cost);
  else if (vendor === "xai") {
    /* xAI bills in ticks: ten billion to the dollar. */
    reported = xaiTicks == null ? null : xaiTicks / 1e10;
  } else {
    const rate = OPENAI_TOKEN_USD[model.id];
    reported = rate && usage?.inputTokens != null && usage?.outputTokens != null ? usage.inputTokens * rate.input + usage.outputTokens * rate.output : null;
  }
  /* Grok Imagine is priced flat per image, so its reported charge must also
     be at least half the quote (xAI's tick unit is not published). */
  const floor = door === "xai" ? 0.5 : 0;
  return { bytes: Buffer.from(image.uint8Array), mime: image.mediaType || "image/png", totalTokens, costUsd: sane(reported, estimate, floor), via: door };
}
