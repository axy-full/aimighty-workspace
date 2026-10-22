import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ATOMIK_THINKING, thinkingFor } from "../../lib/atomikModelPolicy";

/*
 * Atomik's thinking is the workspace's setting (owner, 22 Oct 2026; Amendment (iii) §E): the model behind each setting is the
 * policy's, never a model a request names, and nothing falls back to another paid model. tests/unit/atomikThinking.spec.ts holds
 * the mapping, the turn rules and the Treatment writer; these hold the catalogue it draws on and the routes that read it.
 */

test("the planner catalogue is the Claude part of the verified text catalogue, and excludes media and classifiers", async () => {
  const { ATOMIK_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS, isAtomikModel, isVerifiedTextModel, isRetiredAtomikModel } = await import('../../lib/atomikModelPolicy');
  expect(VERIFIED_TEXT_MODEL_IDS.length).toBe(83);
  expect(ATOMIK_MODEL_IDS.length).toBe(VERIFIED_TEXT_MODEL_IDS.filter((id) => id.startsWith("anthropic/")).length);
  for (const id of ['anthropic/claude-opus-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-fable-5.1']) expect(isAtomikModel(id), id).toBe(true);
  /* Gemini, Grok and OpenAI are verified text (the prompt enhancer reads them) and no longer Atomik's thinking. */
  for (const id of ['google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview', 'spacexai/grok-4.7', 'spacexai/grok-4.1-fast-reasoning', 'openai/gpt-5.5', 'openai/gpt-6-astra', 'openai/gpt-4o-mini']) {
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

test("every Atomik text entry point resolves through the policy, and a workspace without Claude does not plan on OpenAI", async () => {
  /* The chat turn, the ideas and shots drafts, the treatment scene and the memory read all pick through textJobPick (resolveModel). */
  const atomik = readFileSync("lib/atomik.ts", "utf8");
  expect(atomik).toMatch(/const \{ model, effort \} = await textJobPick\("plan"\);/);
  expect(atomik).toMatch(/return \(await textJobPick\(job === "idea" \|\| job === "shot" \? "writing" : job\)\)\.model;/);
  for (const [route, turn] of [["ideas/draft", "writing"], ["shots/draft", "writing"], ["treatment/scene", "treatment"], ["memory/read", "routine"]] as const) {
    const source = readFileSync(`app/api/atomik/${route}/route.ts`, "utf8");
    expect(source, route).toContain(`await resolveModel("auto", "${turn}")`);
    expect(source, route).toContain(`await thinkingEffort("${turn}", model)`);
    expect(source, `${route}: the body's model is not read`).not.toMatch(/body\.model/);
  }

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
    /* OpenAI-only: the setting's Claude model is not served, so the job is refused in plain words, and nothing plans on OpenAI. */
    for (const [sent, job] of [["auto", "idea"], ["openai/gpt-5.5", "shot"], ["openai/gpt-5.5-pro", "writing"]] as const)
      await expect(resolveModel(sent, job), `${sent} ${job}`).rejects.toThrow("Atomik's thinking isn't connected right now. Nothing billed.");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("with Claude served, every text job runs the setting's model whatever it was sent", async () => {
  const prior = process.env.ENGINE_MOCK, priorCatalog = process.env.MODEL_CATALOG;
  /* The checked-in snapshot (every entry served under the mock), never the gateway's live list. */
  process.env.ENGINE_MOCK = "1"; process.env.MODEL_CATALOG = "static";
  try {
    const { resolveModel } = await import("../../lib/atomik");
    /* Outside a workspace the setting reads as the default, Medium. */
    for (const sent of ["auto", "openai/gpt-5.5", "spacexai/grok-4.7", "google/gemini-3.1-pro-preview", "anthropic/claude-haiku-4.5"]) {
      expect(await resolveModel(sent, "idea"), sent).toBe(thinkingFor("medium", "writing").model);
      expect(await resolveModel(sent, "plan"), sent).toBe(ATOMIK_THINKING.medium.model);
      expect(await resolveModel(sent, "routine"), sent).toBe(ATOMIK_THINKING.low.model);
    }
  } finally {
    if (prior === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = prior;
    if (priorCatalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = priorCatalog;
  }
});
