import { test, expect } from "@playwright/test";
import { CLAUDE_MODEL_IDS } from "../../lib/atomikModelPolicy";
import catalogue from "../../lib/modelCatalog.json";
import { vendorRatesIn } from "../helpers/vendorFigures";

// Worker processes are shared across spec files, so the environment this
// test needs is set inside the test and restored afterwards; nothing here
// may leak a live-engine configuration into a neighbouring mocked spec.
const ENV_KEYS = ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "ENGINE_MOCK", "AI_GATEWAY_BASE_URL", "MODEL_CATALOG"] as const;

/* Made-up OpenAI ids and prices (no catalogue entry has them), and a verified Claude id the gateway listed, read at run time, so its gateway
   route is a real one. */
const CLAUDE = CLAUDE_MODEL_IDS.find((id) => catalogue.models.some((m) => m.id === id))!;
const PRICING = { input: "0.0000173", output: "0.0000419" };
const gateway = {
  data: [
    { id: "openai/test-text-listed", type: "language", pricing: PRICING },
    { id: "openai/test-text-unlisted", type: "language", pricing: PRICING },
    { id: "openai/test-image-a", type: "image", pricing: PRICING },
    { id: "openai/test-speech-a", type: "speech", pricing: PRICING },
    { id: CLAUDE, type: "language", pricing: PRICING },
  ],
};

/**
 * With an OpenAI key configured, text models route directly and must be ids
 * the key can list. Media models still run through the Gateway; a key that
 * cannot list models must not make image and speech menus go quiet.
 */
test("a configured OpenAI key gates only its language models, never Gateway-served media", async () => {
  const { catalog, forgetCatalogCache } = await import("../../lib/catalog");
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = "fake-openai-unit-gate";
  process.env.AI_GATEWAY_API_KEY = "gw-unit-catalog-gate";
  delete process.env.ENGINE_MOCK;
  delete process.env.AI_GATEWAY_BASE_URL;
  delete process.env.MODEL_CATALOG; // the gateway's read (stubbed below), whatever catalogue this run was started on
  const realFetch = globalThis.fetch;
  let openaiStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/models") && url.includes("ai-gateway.vercel.sh"))
      return new Response(JSON.stringify(gateway), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://api.openai.com/v1/models")
      return new Response(openaiStatus === 200 ? JSON.stringify({ data: [{ id: "test-text-listed" }, { id: "test-text-elsewhere" }] }) : "{}", { status: openaiStatus });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const verified = (await catalog(true)).map((m) => m.id);
    expect(verified).toEqual(["openai/test-text-listed", "openai/test-image-a", "openai/test-speech-a", CLAUDE]);

    openaiStatus = 401;
    const restricted = (await catalog(true)).map((m) => m.id);
    expect(restricted).toEqual(["openai/test-image-a", "openai/test-speech-a", CLAUDE]);
  } finally {
    globalThis.fetch = realFetch;
    forgetCatalogCache(); // the stubbed read is not left cached for a later spec in this worker
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("no fixture in this file states a vendor's rate", () => {
  expect(vendorRatesIn(PRICING)).toEqual([]);
});
