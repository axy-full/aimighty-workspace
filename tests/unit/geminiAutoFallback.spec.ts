import { test, expect } from "@playwright/test";
import { MEDIUM } from "../helpers/thinkingSlots";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { AUTO_MODEL_IDS, aliasModel, MODEL_ALIASES, readsAsAuto } from "../../lib/modelAliases";
import { atomikModelIds, isAtomikModel, savedAtomikChoice, thinkingFor } from "../../lib/atomikModelPolicy";
import { selectPlannerModel } from "../../lib/workbench/rig-agent-planner";
import { DEFAULT_TEXT_MODELS, TEXT_JOBS, cleanModels, textModelFor } from "../../lib/platformLayer";
import { PROMPT_MODELS, enhanceModelFor } from "../../lib/enhance";
import { textEffect } from "../../lib/textJobRoute";
import { DIRECT_PRICE_TO_CONFIRM, textRouteWorks } from "../../lib/textRoute";
import { staticCatalog } from "../../lib/catalog";

/*
 * Vercel out, Gemini direct (owner, 14 Oct 2026, 22:50): "YES to removing Gemini 2.5 Flash, 2.5 Flash-Lite, 2.5 Pro and 3.8 Flash from the menus, on condition that any saved
 * setting or default pointing at them falls back to Auto with no error and no price change." And (owner, 14 Oct 23:35): "#738: remove all SEVEN from the menus for now. The extra
 * three (3.1-flash-lite, 3.5-flash, 3.7-flash) leave because their price isn't confirmed on Google's page; we never charge on an unconfirmed price. Saved settings pointing at any
 * of the seven read as Auto, same quote, no error (extend AUTO_MODEL_IDS + test). They return in a small PR when the price is confirmed."
 * Every place a text model id is saved or defaulted reads each of the seven as Auto, and the quote a saved reference gets is the quote Auto gets. Real temporary databases; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-gemini-auto-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const NO_DIRECT_MODEL = ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite", "google/gemini-2.5-pro", "google/gemini-3.8-flash"];
const PRICE_TO_CONFIRM = ["google/gemini-3.1-flash-lite", "google/gemini-3.5-flash", "google/gemini-3.7-flash"];
const REMOVED = [...NO_DIRECT_MODEL, ...PRICE_TO_CONFIRM];
const served = [...atomikModelIds()];

test("the seven removed Gemini ids are exactly the ones that read as Auto, and the ordinary aliases are unchanged", () => {
  expect(REMOVED).toHaveLength(7);
  expect([...AUTO_MODEL_IDS].sort()).toEqual([...REMOVED].sort());
  for (const id of REMOVED) { expect(aliasModel(id), id).toBe("auto"); expect(Object.hasOwn(MODEL_ALIASES, id), `${id} has no nearest model`).toBe(false); }
  expect(aliasModel("anthropic/claude-opus-5-fast")).toBe("anthropic/claude-opus-5");
  expect(aliasModel("google/gemini-3.6-flash")).toBe("google/gemini-3.6-flash");
  expect(aliasModel(null)).toBeNull();
});

test("none of the seven is on any menu: no route works for them with every key set, and the catalogue serves none; a confirmed Gemini still is served", () => {
  const keys = ["ENGINE_MOCK", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "TEXT_DIRECT"] as const;
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.ENGINE_MOCK;   // under ENGINE_MOCK every entry is served, so the real rule is read without it
    process.env.GEMINI_API_KEY = "gm-unit-auto"; process.env.AI_GATEWAY_API_KEY = "gw-unit-auto"; delete process.env.TEXT_DIRECT;
    const served = new Set(staticCatalog().map((m) => m.id));
    for (const id of REMOVED) { expect(textRouteWorks(id), `${id}: no route`).toBe(false); expect(served.has(id), `${id}: not on a menu`).toBe(false); }
    /* The three with a direct model are held back by price alone, and the list that holds them is the three. */
    expect([...DIRECT_PRICE_TO_CONFIRM].sort()).toEqual([...PRICE_TO_CONFIRM].sort());
    expect(textRouteWorks("google/gemini-3.6-flash"), "a confirmed Gemini is still offered with the key").toBe(true);
    expect(served.has("google/gemini-3.6-flash")).toBe(true);
  } finally {
    for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});

test("a saved Atomik choice reads as Auto: no note, no error, the same model Auto runs", () => {
  /* Since 22 Oct 2026 a saved or sent model is not asked at all: every Atomik turn runs the Thinking setting's model (lib/atomikModelPolicy › thinkingFor). */
  for (const id of REMOVED) expect(savedAtomikChoice(id), id).toEqual({ model: "auto", note: null });
  const plan = thinkingFor("medium", "plan").model!;
  expect(plan).toBe(MEDIUM);
  expect(selectPlannerModel(plan, served.map((m) => ({ id: m })))).toBe(plan);
  /* A Gemini that stays on the menus is not Atomik's thinking. */
  expect(isAtomikModel("google/gemini-3.6-flash")).toBe(false);
});

test("the platform's saved routing and the job defaults: each job reads the default, whatever the saved id", () => {
  for (const id of REMOVED) {
    const text = Object.fromEntries(TEXT_JOBS.map((job) => [job, id]));
    expect(cleanModels({ text }).text, id).toEqual(DEFAULT_TEXT_MODELS);
    for (const job of TEXT_JOBS) expect(textModelFor({ text: { [job]: id } }, job), `${id} ${job}`).toBe(DEFAULT_TEXT_MODELS[job]);
  }
  expect(textModelFor({ text: { enhance: "anthropic/claude-opus-5-fast" } }, "enhance")).toBe("anthropic/claude-opus-5");
});

test("the prompt writer: a removed id in the deployment's list or the routed choice runs the writer's own default", () => {
  const before = process.env.PROMPT_MODELS;
  try {
    for (const id of REMOVED) {
      process.env.PROMPT_MODELS = `${id},anthropic/claude-sonnet-5`;
      expect(PROMPT_MODELS(), `${id}: the list is read as written`).toEqual([id, "anthropic/claude-sonnet-5"]);
      expect(enhanceModelFor(id), id).toBe("anthropic/claude-sonnet-5");
      expect(enhanceModelFor("auto"), `${id}: and Auto runs the same`).toBe("anthropic/claude-sonnet-5");
    }
  } finally { if (before === undefined) delete process.env.PROMPT_MODELS; else process.env.PROMPT_MODELS = before; }
});

test("the prompt writer: a deployment list that names only removed ids runs the writer's own default, with no error", () => {
  const before = { PROMPT_MODELS: process.env.PROMPT_MODELS, GATEWAY_PROMPT_MODELS: process.env.GATEWAY_PROMPT_MODELS };
  try {
    for (const name of ["PROMPT_MODELS", "GATEWAY_PROMPT_MODELS"] as const) {
      delete process.env.PROMPT_MODELS; delete process.env.GATEWAY_PROMPT_MODELS;
      process.env[name] = REMOVED.join(",");
      expect(PROMPT_MODELS(), `${name}: read as written`).toEqual(REMOVED);
      for (const id of [...REMOVED, "auto", "anthropic/claude-sonnet-5.5", "not/priced"]) expect(() => enhanceModelFor(id), `${name} ${id}`).not.toThrow();
      for (const id of REMOVED) {
        expect(enhanceModelFor(id), `${name} ${id}`).toBe(DEFAULT_TEXT_MODELS.enhance);
        expect(readsAsAuto(enhanceModelFor(id)), `${name} ${id}: never a removed id`).toBe(false);
      }
      /* One removed id among others: the first that is not removed. */
      process.env[name] = `${REMOVED[4]},anthropic/claude-sonnet-5`;
      expect(enhanceModelFor(REMOVED[0]), name).toBe("anthropic/claude-sonnet-5");
    }
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("what a job runs for a saved removed id is what it runs for Auto", () => {
  for (const id of REMOVED) {
    for (const job of ["idea", "shot"] as const) {
      const saved = textEffect(job, id, served, served), auto = textEffect(job, "auto", served, served);
      expect(saved.runs, `${id} ${job}`).toBe(auto.runs);
    }
  }
});

/* The quote a chat saved on a removed id gets is the quote an Auto chat gets: same model, same price, no error. */
type Who = { id: string; role: "admin" | "member"; name: string; email: string };
const me: Who = { id: "u_me", role: "admin", name: "Name u_me", email: "u_me@example.test" };
function loadRoute<T>(file: string): T {
  const root = process.cwd(), real = createRequire(path.resolve(file));
  const session = async () => ({ user: { ...me, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  const fakes: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: session, requireSession: session, requireRender: session },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((n: string) => (Object.hasOwn(fakes, n) ? fakes[n] : n.startsWith("@/") ? real(path.join(root, n.slice(2))) : real(n)), mod, mod.exports);
  return mod.exports as T;
}

test("the quote for a chat saved on any of the seven removed Geminis is Auto's own quote, with no error", async () => {
  const ws = { id: "gauto-ws", name: "gauto", slug: "gauto", legacy: false, dbUrl: `file:${path.join(dir, "gauto.db")}`, dbToken: null, keys: {}, usesPlatformKeys: true } as TenantWorkspace;
  const tenant = await import("../../lib/tenant"), platform = await import("../../lib/platform"), atomik = await import("../../lib/atomik");
  await platform.platformReady();
  await platform.platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [me.id, me.email, me.name, "x"] });
  await platform.platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, me.id, "admin"] });
  const turn = loadRoute<{ POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }>("app/api/atomik/[id]/route.ts");
  const quote = async (model: string) => tenant.runInTenant(ws, async () => {
    const id = await atomik.createChat({ userId: me.id, projectId: null, model, agentMode: "ask" });
    const res = await turn.POST(new Request(`https://particl.test/api/atomik/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quoteOnly: true, text: "Plan two shots at the market." }) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }, { user: { ...me, owner: false, disabled: false, lastSeen: null, createdAt: 0 } });
  const auto = await quote("auto");
  expect(auto.status, "Auto's own quote answers").toBe(200);
  /* A price to compare; the model that runs is never sent (Amendment (iii) §E, owner 22 Oct 2026). */
  expect(auto.body, "a price to compare").toMatchObject({ estimateCredits: expect.any(Number) });
  expect(auto.body).not.toHaveProperty("model");
  for (const id of REMOVED) {
    const saved = await quote(id);
    expect(saved.status, `${id}: no error`).toBe(200);
    expect(saved.body, `${id}: the same quote as Auto, model and price`).toEqual(auto.body);
  }
});
