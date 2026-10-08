import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectAtomikModel } from "../../lib/atomikModelPolicy";

test("Auto ignores unrelated providers and respects an available explicit route", () => {
  const available = ["new-provider/new-model", "anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6"];
  expect(selectAtomikModel("auto", available, "new-provider/new-model")).toBe("anthropic/claude-sonnet-4.6");
  expect(selectAtomikModel("auto", available, "anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
  expect(() => selectAtomikModel("auto", ["new-provider/new-model"])).toThrow("No supported Atomik");
});

test("an explicit retired or unapproved thinking model cannot silently become a different paid model", () => {
  const available = ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5"];
  expect(selectAtomikModel("openai/gpt-5.5", available)).toBe("openai/gpt-5.5");
  expect(() => selectAtomikModel("google/gemini-3-pro-image", available)).toThrow("not offered");
  /* A model Atomik used to offer is refused with the reason, never swapped for another paid model. */
  expect(() => selectAtomikModel("google/gemini-3.1-pro-preview", [...available, "google/gemini-3.1-pro-preview"])).toThrow("no longer offered in Atomik");
  expect(() => selectAtomikModel("openai/gpt-5.4", available)).toThrow("currently unavailable");
  /* A dropped id is not refused: it is its alias, the nearest offered model (lib/modelAliases.ts). */
  expect(selectAtomikModel("openai/gpt-5.5-pro", available)).toBe("openai/gpt-5.5");
  expect(selectAtomikModel("anthropic/claude-sonnet-4.6", available)).toBe("anthropic/claude-sonnet-4.6");
});

test("the planner catalogue is the Claude, OpenAI and Grok part of the verified text catalogue, and excludes media and classifiers", async () => {
  const { ATOMIK_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS, isAtomikModel, isVerifiedTextModel, isRetiredAtomikModel } = await import('../../lib/atomikModelPolicy');
  expect(VERIFIED_TEXT_MODEL_IDS.length).toBe(80);
  expect(ATOMIK_MODEL_IDS.length).toBe(69);
  for (const id of ['openai/gpt-6-astra', 'anthropic/claude-opus-5', 'openai/gpt-4o-mini', 'spacexai/grok-4.7', 'spacexai/grok-4.1-fast-reasoning']) expect(isAtomikModel(id)).toBe(true);
  /* Gemini is verified text, used by the prompt enhancer, and no longer Atomik's. */
  for (const id of ['google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview']) {
    expect(isAtomikModel(id), id).toBe(false);
    expect(isVerifiedTextModel(id), id).toBe(true);
    expect(isRetiredAtomikModel(id), id).toBe(true);
  }
  for (const id of ['openai/gpt-image-2', 'openai/gpt-oss-safeguard-20b', 'google/gemma-3-27b-it', 'anthropic/not-a-real-model', 'spacexai/grok-imagine-image-2.0', 'spacexai/grok-tts']) {
    expect(isAtomikModel(id), id).toBe(false);
    expect(isRetiredAtomikModel(id), id).toBe(false);
  }
});

test('Gateway reasoning metadata rejects malformed and unknown controls', async () => {
  const { parseReasoningOptions } = await import('../../lib/catalog');
  expect(parseReasoningOptions(null)).toEqual([]);
  expect(parseReasoningOptions([{ type: 'effort', values: ['low','low','MAX','infinite',null,'max'] }, { type: 'budget_tokens', min: 1024, max: 8192 }, { type: 'toggle' }, { type: 'budget_tokens', min: -1 }, { type: 'budget_tokens', min: 1024, max: 512 }, { type: 'arbitrary' }])).toEqual([
    { type: 'effort', values: ['low','max'] }, { type: 'budget_tokens', min: 1024, max: 8192 }, { type: 'toggle' },
  ]);
});

test("Auto without a route prefers its own choices: OpenAI-only plans on GPT-5.5, never the first OpenAI id in the catalogue", () => {
  const openai = ["openai/gpt-3.5-turbo", "openai/gpt-4o-mini", "openai/gpt-5-nano", "openai/gpt-5.5"];
  const claude = ["anthropic/claude-haiku-4.5", "anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6"];
  expect(selectAtomikModel("auto", openai)).toBe("openai/gpt-5.5");
  expect(selectAtomikModel("auto", claude)).toBe("anthropic/claude-sonnet-4.6");
  expect(selectAtomikModel("auto", ["anthropic/claude-haiku-4.5", "anthropic/claude-opus-4.6"])).toBe("anthropic/claude-opus-4.6");
  expect(selectAtomikModel("auto", [...openai, ...claude])).toBe("anthropic/claude-sonnet-4.6");
  /* The platform's route still wins when it is served, even outside Auto's list; a dropped route is its alias. */
  expect(selectAtomikModel("auto", [...openai, ...claude], "openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  expect(selectAtomikModel("auto", openai, "anthropic/claude-opus-5")).toBe("openai/gpt-5.5");
  expect(selectAtomikModel("auto", [...openai, ...claude], "openai/gpt-5.5-pro")).toBe("openai/gpt-5.5");
  /* With none of Auto's choices served, the catalogue order decides, as before. */
  expect(selectAtomikModel("auto", ["openai/gpt-4o-mini", "openai/gpt-3.5-turbo"])).toBe("openai/gpt-3.5-turbo");
});

test("every Atomik text entry point resolves Auto the same way: an OpenAI-only workspace plans on GPT-5.5", async () => {
  /* The chat turn, the ideas and shots drafts, the treatment scene and the memory read all pick through resolveModel. */
  const atomik = readFileSync("lib/atomik.ts", "utf8");
  expect(atomik).toMatch(/const model = await resolveModel\(opts\.model \?\? chat\.model, "shot"\);/);
  expect(atomik).toMatch(/try \{ return selectAtomikModel\(want, /);
  for (const route of ["ideas/draft", "shots/draft", "treatment/scene", "memory/read"])
    expect(readFileSync(`app/api/atomik/${route}/route.ts`, "utf8"), route).toMatch(/const model = await resolveModel\(typeof body\.model === "string" \? body\.model\.slice\(0, 120\) : "auto", "(idea|shot)"\);/);

  const keys = ["MODEL_CATALOG", "ENGINE_MOCK", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "TEXT_DIRECT", "VERCEL", "VERCEL_OIDC_TOKEN", "PLATFORM_DATABASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const committed = JSON.parse(readFileSync("lib/modelCatalog.json", "utf8")) as { models: { id: string }[] };
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, {
      MODEL_CATALOG: "static", OPENAI_API_KEY: "sk-unit-auto-openai-only",
      PLATFORM_DATABASE_URL: `file:${path.join(mkdtempSync(path.join(tmpdir(), "particl-auto-")), "platform.db")}`,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) !== "https://api.openai.com/v1/models") throw new Error(`unexpected fetch ${String(input)}`);
      return new Response(JSON.stringify({ data: committed.models.filter((m) => m.id.startsWith("openai/")).map((m) => ({ id: m.id.slice(7) })) }), { status: 200 });
    }) as typeof fetch;
    const { resolveModel } = await import("../../lib/atomik");
    expect(await resolveModel("auto", "idea")).toBe("openai/gpt-5.5");
    expect(await resolveModel("auto", "shot")).toBe("openai/gpt-5.5");
    expect(await resolveModel("openai/gpt-5.5-pro", "idea")).toBe("openai/gpt-5.5");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
