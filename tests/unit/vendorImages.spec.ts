import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { getModel, MODELS } from "../../lib/models";
import { billedTo, getProvider, providerVia } from "../../lib/providers";
import { renderKeyNameFor, vendorKeyNameFor } from "../../lib/platformSpend";
import { estimateImageCostUsd } from "../../lib/vendorPricing";
import { openAISize, vendorStill } from "../../lib/vendorImages";
import { ENGINES } from "../../lib/engines";
import { BOARD_MODELS, stillShape } from "../../lib/production/boards";

/**
 * Owner, 23 September: OpenAI image models in image gens, Grok APIs wherever
 * possible, and each vendor billed as its own charge. GPT Image and Grok
 * Imagine go straight to OpenAI / xAI on their keys (billed OpenAI / xAI);
 * with no key, through the AI Gateway (billed gateway credit). The network is
 * stubbed: what each door is sent, and what it bills, without spending.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-vendor-images-"));
process.env.PLATFORM_DATABASE_URL ??= "file:" + path.join(dir, "platform.db");
const ENV = ["OPENAI_API_KEY", "XAI_API_KEY", "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "ENGINE_MOCK", "VERCEL", "VERCEL_OIDC_TOKEN"] as const;
async function withEnv<T>(values: Partial<Record<(typeof ENV)[number], string>>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  try { for (const name of ENV) delete process.env[name]; Object.assign(process.env, values); return await run(); }
  finally { for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } }
}
type Sent = { url: string; body: Record<string, unknown>; auth: string | null };
async function stubbed<T>(reply: (url: string) => unknown, run: () => Promise<T>): Promise<{ value: T; sent: Sent[] }> {
  const real = globalThis.fetch, sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")), auth: headers.get("authorization") });
    return Response.json(reply(url));
  }) as typeof fetch;
  try { return { value: await run(), sent }; } finally { globalThis.fetch = real; }
}
const png = async () => (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c33" } }).png().toBuffer()).toString("base64");

test("every GPT Image and Grok Imagine model is offered, priced at each size, and has an engine", () => {
  const added = MODELS.filter((m) => (m.provider === "openai" || m.provider === "xai") && m.kind === "image");
  expect(added.map((m) => m.id).sort()).toEqual(["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "grok-imagine-image", "grok-imagine-image-2.0"]);
  for (const model of added) {
    expect(model.kind).toBe("image");
    for (const size of model.resolutions) expect(estimateImageCostUsd(model.id, size, 0)?.net, `${model.id} ${size}`).toBeGreaterThan(0);
    for (const ratio of model.provider === "openai" ? model.ratios : []) expect(openAISize(model, ratio)).toMatch(/^\d+x\d+$/);
  }
  expect(ENGINES.openai.kinds).toEqual(["image"]);
  expect(ENGINES.xai.kinds).toEqual(["image", "video"]);
  /* Flexible sizes are multiples of 16 within OpenAI's bounds. */
  for (const ratio of getModel("gpt-image-2").ratios) {
    const [w, h] = openAISize(getModel("gpt-image-2"), ratio).split("x").map(Number);
    expect(w % 16 + h % 16).toBe(0);
    expect(w * h).toBeGreaterThanOrEqual(655_360);
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
  }
});

test("each vendor bills as itself on its key, and as gateway credit without one", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-unit", XAI_API_KEY: "xai-unit", AI_GATEWAY_API_KEY: "gw-unit" }, () => {
    for (const vendor of ["openai", "xai"] as const) {
      expect(billedTo(vendor)).toBe(vendor);
      expect(providerVia(getProvider(vendor))).toBe("key");
      expect(renderKeyNameFor(vendor)).toBe(vendor);
    }
  });
  await withEnv({ AI_GATEWAY_API_KEY: "gw-unit" }, () => {
    for (const vendor of ["openai", "xai"] as const) {
      expect(billedTo(vendor)).toBe("vercel");
      expect(providerVia(getProvider(vendor))).toBe("gateway");
      expect(renderKeyNameFor(vendor)).toBe("gateway");
      /* The engine that charged keeps its own key name (the meter's reading). */
      expect(vendorKeyNameFor(vendor)).toBe(vendor);
    }
  });
  await withEnv({}, () => { expect(providerVia(getProvider("openai"))).toBeNull(); });
});

test("GPT Image on the OpenAI key: the images endpoint, the size and quality, priced from the usage", async () => {
  const b64 = await png();
  const { value, sent } = await withEnv({ OPENAI_API_KEY: "sk-unit", AI_GATEWAY_API_KEY: "gw-unit" }, () => stubbed(() => ({
    created: 1, data: [{ b64_json: b64 }], usage: { input_tokens: 100, output_tokens: 2000, total_tokens: 2100, input_tokens_details: { text_tokens: 100, image_tokens: 0 } },
  }), () => vendorStill({ model: getModel("gpt-image-2"), prompt: "A red fox on the ice", ratio: "16:9", size: "High", references: [] })));
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe("https://api.openai.com/v1/images/generations");
  expect(sent[0].auth).toBe("Bearer sk-unit");
  expect(sent[0].body).toMatchObject({ model: "gpt-image-2", prompt: "A red fox on the ice", n: 1, size: "1664x928", quality: "high" });
  expect(value.via).toBe("openai");
  expect(value.costUsd).toBeCloseTo(100 * 10e-6 + 2000 * 30e-6, 8);
  expect(value.bytes.toString("base64")).toBe(b64);
});

test("Grok Imagine on the xAI key: the aspect and resolution, priced from xAI's own charge", async () => {
  const b64 = await png();
  const { value, sent } = await withEnv({ XAI_API_KEY: "xai-unit" }, () => stubbed(() => ({
    data: [{ b64_json: b64 }], usage: { cost_in_usd_ticks: 800_000_000 },
  }), () => vendorStill({ model: getModel("grok-imagine-image-2.0"), prompt: "A red fox on the ice", ratio: "16:9", size: "2K", references: [] })));
  expect(sent[0].url).toBe("https://api.x.ai/v1/images/generations");
  expect(sent[0].auth).toBe("Bearer xai-unit");
  expect(sent[0].body).toMatchObject({ model: "grok-imagine-image-2.0", prompt: "A red fox on the ice", n: 1, aspect_ratio: "16:9", resolution: "2k", response_format: "b64_json" });
  expect(value).toMatchObject({ via: "xai", costUsd: 0.08 });
});

test("without a vendor key the still goes through the gateway and bills the gateway's reported cost", async () => {
  const b64 = await png();
  const { value, sent } = await withEnv({ AI_GATEWAY_API_KEY: "gw-unit" }, () => stubbed(() => ({
    images: [b64], providerMetadata: { gateway: { cost: "0.06" } },
  }), () => vendorStill({ model: getModel("grok-imagine-image-2.0"), prompt: "A red fox", ratio: "1:1", size: "1K", references: [] })));
  expect(sent[0].url).toMatch(/\/v4\/ai\/image-model$/);
  expect(sent[0].auth).toBe("Bearer gw-unit");
  expect(value).toMatchObject({ via: "gateway", costUsd: 0.06 });
});

test("a reported charge off by a unit falls back to the quote rather than billing it", async () => {
  const b64 = await png();
  for (const ticks of [2_000_000_000, 20_000_000, 9e15]) {
    const { value } = await withEnv({ XAI_API_KEY: "xai-unit" }, () => stubbed(() => ({ data: [{ b64_json: b64 }], usage: { cost_in_usd_ticks: ticks } }),
      () => vendorStill({ model: getModel("grok-imagine-image"), prompt: "A fox", ratio: "1:1", size: "1K", references: [] })));
    expect(value.costUsd, String(ticks)).toBeNull();
  }
});

test("Storyboards offers GPT Image and Grok Imagine, each asked for a ratio and size it makes", () => {
  expect(BOARD_MODELS.map((m) => m.id)).toEqual(expect.arrayContaining(["gpt-image-2", "gpt-image-2.5-flare", "grok-imagine-image-2.0"]));
  expect(stillShape(getModel("gpt-image-2"), "16:9")).toEqual({ ratio: "16:9", resolution: "Medium" });
  expect(stillShape(getModel("gpt-image-1.5"), "16:9")).toEqual({ ratio: "3:2", resolution: "Medium" });
  expect(stillShape(getModel("grok-imagine-image-2.0"), "4:5")).toEqual({ ratio: "3:4", resolution: "1K" });
  expect(stillShape(getModel("gemini-3.1-flash-image"), "4:5")).toEqual({ ratio: "4:5", resolution: "1K" });
});
