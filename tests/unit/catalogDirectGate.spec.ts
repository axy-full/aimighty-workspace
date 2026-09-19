import { test, expect } from "@playwright/test";

// Worker processes are shared across spec files, so the environment this
// test needs is set inside the test and restored afterwards; nothing here
// may leak a live-engine configuration into a neighbouring mocked spec.
const ENV_KEYS = ["OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "ENGINE_MOCK", "AI_GATEWAY_BASE_URL"] as const;

const gateway = {
  data: [
    { id: "openai/gpt-6-astra", type: "language", pricing: { input: "0.00001", output: "0.00005" } },
    { id: "openai/gpt-5.5-fast", type: "language", pricing: { input: "0.00001", output: "0.00005" } },
    { id: "openai/gpt-image-2", type: "image", pricing: { input: "0.00001", output: "0.00005" } },
    { id: "openai/tts-1-hd", type: "speech", pricing: { input: "0.00001", output: "0.00005" } },
    { id: "anthropic/claude-sonnet-5", type: "language", pricing: { input: "0.00001", output: "0.00005" } },
  ],
};

/**
 * With an OpenAI key configured, text models route directly and must be ids
 * the key can list. Media models still run through the Gateway; a key that
 * cannot list models must not make image and speech menus go quiet.
 */
test("a configured OpenAI key gates only its language models, never Gateway-served media", async () => {
  const { catalog } = await import("../../lib/catalog");
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = "sk-unit-catalog-gate";
  process.env.AI_GATEWAY_API_KEY = "gw-unit-catalog-gate";
  delete process.env.ENGINE_MOCK;
  delete process.env.AI_GATEWAY_BASE_URL;
  const realFetch = globalThis.fetch;
  let openaiStatus = 200;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/models") && url.includes("ai-gateway.vercel.sh"))
      return new Response(JSON.stringify(gateway), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://api.openai.com/v1/models")
      return new Response(openaiStatus === 200 ? JSON.stringify({ data: [{ id: "gpt-6-astra" }, { id: "gpt-4.1" }] }) : "{}", { status: openaiStatus });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const verified = (await catalog(true)).map((m) => m.id);
    expect(verified).toEqual(["openai/gpt-6-astra", "openai/gpt-image-2", "openai/tts-1-hd", "anthropic/claude-sonnet-5"]);

    openaiStatus = 401;
    const restricted = (await catalog(true)).map((m) => m.id);
    expect(restricted).toEqual(["openai/gpt-image-2", "openai/tts-1-hd", "anthropic/claude-sonnet-5"]);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
