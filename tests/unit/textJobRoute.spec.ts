import { test, expect } from "@playwright/test";
import { GEMINI_IDS, GROK_IDS, MEDIUM } from "../helpers/thinkingSlots";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DEFAULT_THINKING, VERIFIED_TEXT_MODEL_IDS, thinkingFor } from "../../lib/atomikModelPolicy";
import { enhanceModelFor } from "../../lib/enhance";
import { textEffect, textModelsByJob } from "../../lib/textJobRoute";
import { TEXT_JOBS, DEFAULT_LAYER } from "../../lib/platformLayer";

/**
 * Admin text routing lists, per job, only the models that job really runs (#649 review): a choice a job cannot run would silently run as
 * something else (ideas and shots run Atomik's Thinking setting whatever is saved, since 22 Oct 2026; most models for prompt enhancement fall
 * back to the deployment's writer list).
 * Under ENGINE_MOCK every model has a working route, so this tests the rules themselves.
 */
process.env.ENGINE_MOCK = "1";
const ROUTABLE = [...VERIFIED_TEXT_MODEL_IDS];

test("every model a job lists runs exactly as chosen, and every model it leaves out would have run as something else", () => {
  const lists = textModelsByJob(ROUTABLE);
  for (const job of TEXT_JOBS) {
    expect(lists[job].length, job).toBeGreaterThan(0);
    for (const id of ROUTABLE) {
      /* Ideas and shots run the Thinking setting's Writing model (shown at the default setting), whatever was saved. */
      const ran = job === "enhance" ? enhanceModelFor(id) : thinkingFor(DEFAULT_THINKING, "writing").model;
      if (lists[job].includes(id)) expect(ran, `${job}: ${id} is listed, so it runs as chosen`).toBe(id);
      else expect(ran, `${job}: ${id} is not listed, so it would have run as something else`).not.toBe(id);
    }
  }
});

test("ideas and shots do not list Gemini; prompt enhancement lists only the models its writer is priced for", () => {
  const lists = textModelsByJob(ROUTABLE);
  for (const job of ["idea", "shot"] as const) {
    expect(lists[job].some((id) => id.startsWith("google/"))).toBe(false);
    expect(lists[job]).toContain(MEDIUM);
  }
  expect(lists.enhance.some((id) => id.startsWith("openai/") || id.startsWith("xai/") || id.startsWith("spacexai/"))).toBe(false);
  expect(lists.enhance).toContain("anthropic/claude-sonnet-5.5");
  expect(lists.enhance).toContain("google/gemini-3.1-pro-preview");
});

test("a saved choice that cannot run says what runs in its place; one that can says so too", () => {
  const gemini = GEMINI_IDS[0];
  /* Ideas and shots run the default setting's (Medium's) slot. */
  expect(textEffect("idea", gemini, ROUTABLE)).toEqual({ saved: gemini, runnable: false, runs: MEDIUM });
  expect(textEffect("shot", MEDIUM, ROUTABLE)).toEqual({ saved: MEDIUM, runnable: true, runs: MEDIUM });
  const gpt = ROUTABLE.find((id) => id.startsWith("openai/"))!;
  const effect = textEffect("enhance", gpt, ROUTABLE);
  expect(effect.runnable).toBe(false);
  /* The enhancer's stand-in is the deployment's own first writer, which the owner made Opus 5.5 on 16 Oct 2026. */
  expect(effect.runs).toBe("anthropic/claude-opus-5.5");
  /* Nothing Atomik runs is connected: no stand-in. */
  expect(textEffect("idea", gemini, [gemini]).runs).toBeNull();
});

/** The admin route, loaded with its imports stubbed: `routable` is the priced list, `served` every language model the catalogue lists. */
async function adminRoute(text: Record<string, string>, routable: string[], served: string[]) {
  const layer = { ...DEFAULT_LAYER, models: { ...DEFAULT_LAYER.models, text } };
  const deps: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown) => ({ json: async () => body }) } },
    "@/lib/recovery": { recoveryRoute: (h: unknown) => h },
    "@/lib/auth": { requireSuperAdmin: async () => ({ user: { id: "u" } }) },
    "@/lib/platform": { platformLayerState: async () => ({ value: layer, stored: [] }), setPlatformLayer: async () => null, resetPlatformLayer: async () => null },
    "@/lib/platformLayer": await import("../../lib/platformLayer"),
    "@/lib/catalog": { routableTextModelIds: async () => routable, catalog: async () => served.map((id) => ({ id, type: "language" })) },
    "@/lib/textJobRoute": await import("../../lib/textJobRoute"),
    "@/lib/studio": { CATEGORIES: [] },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/admin/platform-layer/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { GET: () => Promise<{ json: () => Promise<Record<string, any>> }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function("require", "module", "exports", compiled)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected import ${name}`); return deps[name]; }, mod, mod.exports);
  return (await mod.exports.GET()).json();
}

test("the admin route sends each job its own list and what a saved choice does", async () => {
  const body = await adminRoute({ enhance: "openai/gpt-5.5", idea: "google/gemini-3.1-pro-preview", shot: MEDIUM }, ROUTABLE, ROUTABLE);
  expect(body.textModelsByJob.idea.some((id: string) => id.startsWith("google/"))).toBe(false);
  expect(body.textModelsByJob.enhance.includes("openai/gpt-5.5")).toBe(false);
  expect(body.textEffects.idea).toMatchObject({ runnable: false, runs: MEDIUM });
  expect(body.textEffects.enhance).toMatchObject({ runnable: false, runs: "anthropic/claude-opus-5.5" });
  expect(body.textEffects.shot).toMatchObject({ runnable: true });
});

/** Everything that decides whether a text model has a route (lib/textRoute.ts › textRouteWorks): the mock, the gateway's key and identity, the direct doors and their keys, the deployment's name, the catalogue source. */
const ROUTE_ENV = ["ENGINE_MOCK", "TEXT_DIRECT", "MODEL_CATALOG", "PROMPT_MODELS", "VERCEL", "VERCEL_ENV", "VERCEL_OIDC_TOKEN", "PARTICL_DEPLOYMENT",
  "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"] as const;
/** Runs with exactly `env` set and every other routing variable cleared, then puts back what an earlier spec in this worker left. */
async function withRouteEnv<T>(env: Partial<Record<(typeof ROUTE_ENV)[number], string>>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(ROUTE_ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of ROUTE_ENV) delete process.env[name];
    Object.assign(process.env, env);
    return await run();
  } finally {
    for (const name of ROUTE_ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
}

test("a saved enhance choice never reads \"X runs instead\" with X itself: it runs as saved, names the real stand-in, or says nothing can run it", async () => {
  const saved = "anthropic/claude-sonnet-5.5";
  /* Priced, with a working route, but not on the admin's list: the writer runs it as saved. */
  await withRouteEnv({ ENGINE_MOCK: "1" }, () => {
    expect(textEffect("enhance", saved, [])).toEqual({ saved, runnable: true, runs: saved });
  });
  /* No model in the writer's list has a route (no engine mock, no keys, no gateway, whatever an earlier spec left set): the old rule's stand-in was the first of the list, which could be the saved model itself. */
  await withRouteEnv({ PROMPT_MODELS: saved }, () => {
    expect(enhanceModelFor(saved)).toBe(saved);
    expect(textEffect("enhance", saved, ROUTABLE)).toEqual({ saved, runnable: false, runs: null });
  });
  await withRouteEnv({ PROMPT_MODELS: "google/gemini-3.1-pro-preview" }, () => {
    expect(textEffect("enhance", saved, ROUTABLE)).toEqual({ saved, runnable: false, runs: null });
  });
  /* With routes, a saved model the writer is not priced for gets the first of its list that works. */
  await withRouteEnv({ ENGINE_MOCK: "1" }, () => {
    const gpt = ROUTABLE.find((id) => id.startsWith("openai/"))!;
    const effect = textEffect("enhance", gpt, ROUTABLE);
    expect(effect.runs).not.toBe(gpt);
    expect(effect.runs).toBe(enhanceModelFor(gpt));
  });
});

test("ideas and shots run the Thinking setting's model when the catalogue serves it, as Atomik does at run time, not the admin's priced list", async () => {
  /* `opus` is the Medium slot's model (tests/helpers/thinkingSlots): what ideas and shots run at the default setting. */
  const gemini = GEMINI_IDS[0], opus = MEDIUM, grok = GROK_IDS[0];
  /* A served Claude that is not on the priced list still runs as saved. */
  expect(textEffect("idea", opus, [grok], [opus, grok])).toEqual({ saved: opus, runnable: true, runs: opus });
  /* What runs instead is the default Thinking setting's Writing model, not the first of the priced list. */
  expect(textEffect("shot", gemini, [grok], [opus, grok])).toEqual({ saved: gemini, runnable: false, runs: opus });
  expect(textEffect("shot", gemini, [grok], [opus, grok]).runs).toBe(thinkingFor(DEFAULT_THINKING, "writing").model);
  /* Served-but-unlisted saved models are not an error; nothing Atomik runs served means no stand-in. */
  expect(textEffect("idea", gemini, [grok], [gemini])).toEqual({ saved: gemini, runnable: false, runs: null });
  /* A dropped id reads as its alias: what runs is the alias, and it is not "as saved". */
  const body = await adminRoute({ idea: gemini, shot: opus, enhance: "anthropic/claude-sonnet-5.5" }, [grok], [opus, grok]);
  expect(body.textEffects.idea).toEqual({ saved: gemini, runnable: false, runs: opus });
  expect(body.textEffects.shot).toEqual({ saved: opus, runnable: true, runs: opus });
  /* Grok is not Atomik's thinking (owner, 22 Oct 2026): a shot list cannot run it, so it is not offered. */
  expect(body.textModelsByJob.shot).toEqual([]);
});
