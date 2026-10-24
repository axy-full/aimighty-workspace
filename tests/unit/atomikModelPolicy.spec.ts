import { test, expect } from "@playwright/test";
import { NOT_TEXT_IDS } from "../helpers/runtimeIds";
import { GEMINI_IDS, GROK_IDS, HIGH, LOW, MEDIUM, OPENAI_IDS, OTHER_CLAUDE } from "../helpers/thinkingSlots";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { thinkingFor } from "../../lib/atomikModelPolicy";

/*
 * Atomik's thinking is the workspace's setting (owner, 22 Oct 2026; Amendment (iii) §E): the model behind each setting is the
 * deployment's env (a slot), never a model a request names, and nothing falls back to another paid model. tests/unit/atomikThinking.spec.ts
 * holds the slots, the turn rules and the Treatment writer; these hold the catalogue it draws on and the routes that read it.
 */

test("the planner catalogue is the slots' models, all verified Claude text, and excludes media and classifiers", async () => {
  const { CLAUDE_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS, atomikModelIds, isAtomikModel, isVerifiedTextModel, isRetiredAtomikModel } = await import('../../lib/atomikModelPolicy');
  expect(VERIFIED_TEXT_MODEL_IDS.length).toBe(83);
  /* Three Claude models only (owner, 23 Oct 2026): the slots' models; every other Claude id is verified text but not Atomik's. */
  expect(atomikModelIds()).toEqual([HIGH, MEDIUM, LOW]);
  for (const id of atomikModelIds()) { expect(isAtomikModel(id), id).toBe(true); expect(isVerifiedTextModel(id), id).toBe(true); }
  const others = CLAUDE_MODEL_IDS.filter((id) => ![HIGH, MEDIUM, LOW].includes(id));
  expect(others.length).toBeGreaterThan(0);
  for (const id of others) { expect(isAtomikModel(id), id).toBe(false); expect(isVerifiedTextModel(id), id).toBe(true); }
  /* Gemini, Grok and OpenAI are verified text (the prompt enhancer reads them) and no longer Atomik's thinking. */
  for (const id of [...GEMINI_IDS, ...GROK_IDS, ...OPENAI_IDS]) {
    expect(isAtomikModel(id), id).toBe(false);
    expect(isVerifiedTextModel(id), id).toBe(true);
    expect(isRetiredAtomikModel(id), id).toBe(true);
  }
  /* The catalogue's entries that are not text models (by its own type, not the verified list), and an id that is none of its: not
     Atomik's, not verified text, not retired text. A media id let into the verified list would fail here. */
  expect(NOT_TEXT_IDS.length).toBeGreaterThan(0);
  const { snapshotModels } = await import('../../lib/catalog');
  expect(NOT_TEXT_IDS.map((id) => snapshotModels().find((m) => m.id === id)?.type)).not.toContain('language');
  for (const id of [...NOT_TEXT_IDS, 'anthropic/not-a-real-model']) {
    expect(isVerifiedTextModel(id), id).toBe(false);
    expect(isAtomikModel(id), id).toBe(false);
    expect(isRetiredAtomikModel(id), id).toBe(false);
  }
});

test("xAI is not in the Atomik allowlist: the family list is Claude's alone, no Grok id (either spelling) is Atomik's, and a slot set to one is empty", async () => {
  /* The owner, 24 Oct 2026 (item 14 (a)): "The xAI family leaves the Atomik allowlist in the same PR." Grok stays verified text for the prompt
     enhancer, and Crew keeps its own engine (a money question, not this allowlist's). */
  const { ATOMIK_FAMILIES, CLAUDE_MODEL_IDS, atomikModelIds, atomikThinkingSlots, isAtomikModel, thinkingModelEnv } = await import("../../lib/atomikModelPolicy");
  expect([...ATOMIK_FAMILIES]).toEqual(["anthropic"]);
  expect(CLAUDE_MODEL_IDS.length).toBeGreaterThan(0);
  for (const id of CLAUDE_MODEL_IDS) expect(id.startsWith("anthropic/"), id).toBe(true);
  expect(GROK_IDS.length, "the verified list still holds Grok, so this check can fail").toBeGreaterThan(0);
  const grok = [...GROK_IDS, ...GROK_IDS.map((id) => id.replace(/^spacexai\//, "xai/"))];
  for (const id of grok) {
    expect(CLAUDE_MODEL_IDS, id).not.toContain(id);
    expect(isAtomikModel(id), id).toBe(false);
    for (const setting of ["high", "medium", "low"] as const) {
      const env = { [thinkingModelEnv("high")]: HIGH, [thinkingModelEnv("medium")]: MEDIUM, [thinkingModelEnv("low")]: LOW, [thinkingModelEnv(setting)]: id };
      expect(atomikThinkingSlots(env)[setting].model, `${setting} = ${id}`).toBeNull();
      expect(atomikModelIds(env), `${setting} = ${id}`).not.toContain(id);
    }
  }
  /* No configured slot reaches outside Claude. */
  for (const id of atomikModelIds()) expect(id.startsWith("anthropic/"), id).toBe(true);
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
    expect(source, route).toContain(`await thinkingRun("${turn}", model)`);
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
    for (const [sent, job] of [["auto", "idea"], [OPENAI_IDS[0], "shot"], [OPENAI_IDS[1], "writing"]] as const)
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
    for (const sent of ["auto", OPENAI_IDS[0], GROK_IDS[0], GEMINI_IDS[0], OTHER_CLAUDE[0]]) {
      expect(await resolveModel(sent, "idea"), sent).toBe(thinkingFor("medium", "writing").model);
      expect(await resolveModel(sent, "plan"), sent).toBe(MEDIUM);
      expect(await resolveModel(sent, "routine"), sent).toBe(LOW);
    }
  } finally {
    if (prior === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = prior;
    if (priorCatalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = priorCatalog;
  }
});
