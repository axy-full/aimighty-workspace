import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { VERIFIED_TEXT_MODEL_IDS, selectAtomikModel } from "../../lib/atomikModelPolicy";
import { enhanceModelFor } from "../../lib/enhance";
import { textEffect, textModelsByJob } from "../../lib/textJobRoute";
import { TEXT_JOBS, DEFAULT_LAYER } from "../../lib/platformLayer";

/**
 * Admin text routing lists, per job, only the models that job really runs (#649 review): a choice a job cannot run would silently run as
 * something else (Gemini for ideas or shots reads as Auto; most models for prompt enhancement fall back to the deployment's writer list).
 * Under ENGINE_MOCK every model has a working route, so this tests the rules themselves.
 */
process.env.ENGINE_MOCK = "1";
const ROUTABLE = [...VERIFIED_TEXT_MODEL_IDS];

test("every model a job lists runs exactly as chosen, and every model it leaves out would have run as something else", () => {
  const lists = textModelsByJob(ROUTABLE);
  for (const job of TEXT_JOBS) {
    expect(lists[job].length, job).toBeGreaterThan(0);
    for (const id of ROUTABLE) {
      const ran = job === "enhance" ? enhanceModelFor(id) : selectAtomikModel("auto", ROUTABLE, id);
      if (lists[job].includes(id)) expect(ran, `${job}: ${id} is listed, so it runs as chosen`).toBe(id);
      else expect(ran, `${job}: ${id} is not listed, so it would have run as something else`).not.toBe(id);
    }
  }
});

test("ideas and shots do not list Gemini; prompt enhancement lists only the models its writer is priced for", () => {
  const lists = textModelsByJob(ROUTABLE);
  for (const job of ["idea", "shot"] as const) {
    expect(lists[job].some((id) => id.startsWith("google/"))).toBe(false);
    expect(lists[job]).toContain("anthropic/claude-opus-5.5");
  }
  expect(lists.enhance.some((id) => id.startsWith("openai/") || id.startsWith("xai/") || id.startsWith("spacexai/"))).toBe(false);
  expect(lists.enhance).toContain("anthropic/claude-sonnet-5.5");
  expect(lists.enhance).toContain("google/gemini-3.1-pro-preview");
});

test("a saved choice that cannot run says what runs in its place; one that can says so too", () => {
  const gemini = "google/gemini-3.1-pro-preview";
  expect(textEffect("idea", gemini, ROUTABLE)).toEqual({ saved: gemini, runnable: false, runs: "anthropic/claude-sonnet-5.5" });
  expect(textEffect("shot", "anthropic/claude-opus-5.5", ROUTABLE)).toEqual({ saved: "anthropic/claude-opus-5.5", runnable: true, runs: "anthropic/claude-opus-5.5" });
  const gpt = ROUTABLE.find((id) => id.startsWith("openai/"))!;
  const effect = textEffect("enhance", gpt, ROUTABLE);
  expect(effect.runnable).toBe(false);
  expect(effect.runs).toBe("anthropic/claude-sonnet-5.5");
  /* Nothing Atomik runs is connected: no stand-in. */
  expect(textEffect("idea", gemini, [gemini]).runs).toBeNull();
});

test("the admin route sends each job its own list and what a saved choice does", async () => {
  const layer = { ...DEFAULT_LAYER, models: { ...DEFAULT_LAYER.models, text: { enhance: "openai/gpt-5.5", idea: "google/gemini-3.1-pro-preview", shot: "anthropic/claude-opus-5.5" } } };
  const deps: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown) => ({ json: async () => body }) } },
    "@/lib/recovery": { recoveryRoute: (h: unknown) => h },
    "@/lib/auth": { requireSuperAdmin: async () => ({ user: { id: "u" } }) },
    "@/lib/platform": { platformLayerState: async () => ({ value: layer, stored: [] }), setPlatformLayer: async () => null, resetPlatformLayer: async () => null },
    "@/lib/platformLayer": await import("../../lib/platformLayer"),
    "@/lib/catalog": { routableTextModelIds: async () => ROUTABLE },
    "@/lib/textJobRoute": await import("../../lib/textJobRoute"),
    "@/lib/studio": { CATEGORIES: [] },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/admin/platform-layer/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { GET: () => Promise<{ json: () => Promise<Record<string, any>> }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function("require", "module", "exports", compiled)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected import ${name}`); return deps[name]; }, mod, mod.exports);
  const body = await (await mod.exports.GET()).json();
  expect(body.textModelsByJob.idea.some((id: string) => id.startsWith("google/"))).toBe(false);
  expect(body.textModelsByJob.enhance.includes("openai/gpt-5.5")).toBe(false);
  expect(body.textEffects.idea).toMatchObject({ runnable: false, runs: "anthropic/claude-sonnet-5.5" });
  expect(body.textEffects.enhance).toMatchObject({ runnable: false, runs: "anthropic/claude-sonnet-5.5" });
  expect(body.textEffects.shot).toMatchObject({ runnable: true });
});
