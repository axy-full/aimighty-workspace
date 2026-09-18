import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "particl-refine-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.ENGINE_MOCK = "0";
process.env.AI_GATEWAY_API_KEY = "unit-fixture-no-provider-access";
process.env.ARK_API_KEY = "unit-fixture-no-provider-access";

for (const status of [400, 503]) {
  test(`gateway refinement submits once after ${status}, including rejected cache formats`, async () => {
    const { runInTenant } = await import("../../lib/tenant");
    const { rowToWorkspace } = await import("../../lib/platform");
    const { enhancePrompt } = await import("../../lib/enhance");
    const fetchBefore = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('{"error":{"message":"unsupported cache_control"}}', {
        status,
      });
    };
    try {
      const ws = rowToWorkspace({
        id: "refine",
        legacy: 1,
        db_url: process.env.TURSO_DATABASE_URL,
        uses_platform_keys: 1,
      });
      await expect(
        runInTenant(ws, () =>
          enhancePrompt({
            prompt: "A boat drifts",
            citations: [],
            provider: "gateway",
          }),
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
}

test("BytePlus refinement does not fall through to a second model when access is denied", async () => {
  const { enhancePrompt } = await import("../../lib/enhance");
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":{"code":"ModelNotOpen"}}', { status: 403 });
  };
  try {
    await expect(
      enhancePrompt({
        prompt: "A boat drifts",
        citations: [],
        provider: "byteplus",
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});


test("a direct OpenAI override cannot create an unquoted inline refinement", async () => {
  const { enhancePrompt } = await import('../../lib/enhance');
  const previous = { models: process.env.GATEWAY_PROMPT_MODELS, key: process.env.OPENAI_API_KEY, mock: process.env.ENGINE_MOCK };
  const fetchBefore = globalThis.fetch; let calls = 0;
  process.env.GATEWAY_PROMPT_MODELS = 'openai/gpt-6-astra';
  process.env.OPENAI_API_KEY = 'unit-fixture-not-sent';
  process.env.ENGINE_MOCK = '0';
  globalThis.fetch = async () => { calls++; throw new Error('unexpected dispatch'); };
  try {
    await expect(enhancePrompt({ prompt: 'A boat drifts', citations: [], provider: 'gateway' })).rejects.toThrow('quoted Atomik request');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [name, value] of [['GATEWAY_PROMPT_MODELS', previous.models], ['OPENAI_API_KEY', previous.key], ['ENGINE_MOCK', previous.mock]]) if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});
