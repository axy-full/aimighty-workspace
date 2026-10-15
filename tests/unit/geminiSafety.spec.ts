import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { GEMINI_SAFETY_CATEGORIES, GEMINI_SAFETY_SETTINGS, SAFETY_BLOCK_MESSAGE, TEXT_SAFETY_BLOCK_MESSAGE, geminiBlockReason, geminiSafetyProviderOptions, geminiSafetySettings, safetyBlockLog } from "../../lib/geminiSafety";

/**
 * Gemini safety (lib/geminiSafety.ts; owner, 14 Oct 2026): one shared configuration, the four adjustable categories at BLOCK_NONE on every Gemini call, pinned here and by a scan of
 * the source so it cannot change silently; and a block by Google's own fixed filters is a plain message, charges nothing and logs only the reason and the take's id.
 * Every Gemini call here is a stand-in: no real call, nothing billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-gemini-safety-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const FOUR = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map((category) => ({ category, threshold: "BLOCK_NONE" }));

test("the configuration is exactly the four adjustable categories at BLOCK_NONE, frozen, and no environment variable moves it", () => {
  expect(GEMINI_SAFETY_SETTINGS).toEqual(FOUR);
  expect(geminiSafetySettings()).toBe(GEMINI_SAFETY_SETTINGS);
  expect([...GEMINI_SAFETY_CATEGORIES]).toEqual(FOUR.map((s) => s.category));
  expect(Object.isFrozen(GEMINI_SAFETY_SETTINGS)).toBe(true);
  for (const setting of GEMINI_SAFETY_SETTINGS) expect(Object.isFrozen(setting)).toBe(true);
  expect(() => { (GEMINI_SAFETY_SETTINGS as unknown as unknown[]).push({}); }).toThrow();
  const before = process.env.GOOGLE_SAFETY_THRESHOLD;
  process.env.GOOGLE_SAFETY_THRESHOLD = "BLOCK_LOW_AND_ABOVE";
  try { expect(geminiSafetySettings()).toEqual(FOUR); expect(geminiSafetyProviderOptions()).toEqual({ google: { safetySettings: FOUR }, vertex: { safetySettings: FOUR } }); }
  finally { if (before === undefined) delete process.env.GOOGLE_SAFETY_THRESHOLD; else process.env.GOOGLE_SAFETY_THRESHOLD = before; }
});

function sourceFiles(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

test("no other file builds safety settings: HARM_CATEGORY and a threshold are named only in lib/geminiSafety.ts; the two requests that carry them take them from it; nothing reads GOOGLE_SAFETY_THRESHOLD", () => {
  const files = ["lib", "app", "components", "scripts"].flatMap((d) => sourceFiles(path.resolve(d)));
  const rel = (f: string) => path.relative(process.cwd(), f);
  const naming = files.filter((f) => /HARM_CATEGORY|BLOCK_ONLY_HIGH|BLOCK_MEDIUM_AND_ABOVE|BLOCK_LOW_AND_ABOVE|BLOCK_NONE/.test(readFileSync(f, "utf8"))).map(rel);
  expect(naming).toEqual(["lib/geminiSafety.ts"]);
  expect(files.filter((f) => /GEMINI_IMAGE_MODEL/.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  const keyed = files.filter((f) => /safetySettings|safety_settings/.test(readFileSync(f, "utf8"))).map(rel).sort();
  expect(keyed).toEqual(["lib/gemini.ts", "lib/geminiSafety.ts"]);
  const gemini = readFileSync("lib/gemini.ts", "utf8");
  expect(gemini.match(/geminiSafetySettings\(\)/g)?.length).toBe(2);
  expect(gemini).not.toMatch(/threshold/i);
  expect(readFileSync("lib/language-provider.ts", "utf8")).toContain("geminiSafetyProviderOptions()");
  expect(files.filter((f) => /GOOGLE_SAFETY_THRESHOLD/.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
});

/* ── The image requests, both doors, through a stand-in for the network ── */

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => (name in overrides ? overrides[name] : name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts")) : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts")) : nodeRequire(name)),
    target, target.exports,
  );
  return target.exports as T;
}
type Sent = { url: string; body: Record<string, unknown> };
function gemini(replies: Array<{ status?: number; body: unknown }>) {
  const sent: Sent[] = [];
  const recovery = { recoveryFetch: async (url: string, init: { body: string }) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); const r = replies.shift()!; return new Response(JSON.stringify(r.body), { status: r.status ?? 200 }); } };
  const lib = load<typeof import("../../lib/gemini")>("lib/gemini.ts", { "./recovery": recovery });
  return { lib, sent };
}
const model = { id: "gemini-3-pro-image", label: "Nano Banana Pro", gatewayId: "google/gemini-3-pro-image" } as never;
const ask = { model, prompt: "A harbour at dawn, a private secret word", ratio: "1:1", size: "1K", references: [] };
const png = Buffer.from("png").toString("base64");

async function withDoor<T>(door: "google" | "gateway", run: () => Promise<T>): Promise<T> {
  const saved = { m: process.env.ENGINE_MOCK, g: process.env.GEMINI_API_KEY, a: process.env.AI_GATEWAY_API_KEY };
  delete process.env.ENGINE_MOCK;
  if (door === "google") { process.env.GEMINI_API_KEY = "test-key-not-real"; delete process.env.AI_GATEWAY_API_KEY; }
  else { delete process.env.GEMINI_API_KEY; process.env.AI_GATEWAY_API_KEY = "test-gateway-key-not-real"; }
  try { return await run(); }
  finally { for (const [k, v] of [["ENGINE_MOCK", saved.m], ["GEMINI_API_KEY", saved.g], ["AI_GATEWAY_API_KEY", saved.a]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("both image doors send the four categories at BLOCK_NONE, from the one configuration", async () => {
  await withDoor("google", async () => {
    const { lib, sent } = gemini([{ body: { output_image: { data: png, mime_type: "image/jpeg" } } }]);
    await lib.generateImage(ask);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.safety_settings).toEqual(FOUR);
  });
  await withDoor("gateway", async () => {
    const { lib, sent } = gemini([{ body: { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }], usage: { cost: 0.01 } } }]);
    await lib.generateImage(ask);
    const options = (sent[0].body.providerOptions as { google: { safetySettings: unknown }; vertex: { safetySettings: unknown } });
    expect(options.google.safetySettings).toEqual(FOUR);
    expect(options.vertex.safetySettings).toEqual(FOUR);
  });
});

test("the model id on the wire is the routing table's, whatever the environment says; a refusal of the settings is retried once and logged without a body", async () => {
  const before = process.env.GEMINI_IMAGE_MODEL;
  process.env.GEMINI_IMAGE_MODEL = "some-dearer-model";
  const warned: string[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    await withDoor("google", async () => {
      const { lib, sent } = gemini([{ status: 400, body: { error: { message: "safety_settings is not supported here, a private secret word" } } }, { body: { output_image: { data: png, mime_type: "image/jpeg" } } }]);
      await lib.generateImage(ask);
      expect(sent.map((s) => s.body.model)).toEqual(["gemini-3-pro-image", "gemini-3-pro-image"]);
      expect(sent[0].body.safety_settings).toEqual(FOUR);
      expect(sent[1].body.safety_settings).toBeUndefined();
    });
  } finally { console.warn = warn; if (before === undefined) delete process.env.GEMINI_IMAGE_MODEL; else process.env.GEMINI_IMAGE_MODEL = before; }
  const lines = warned.filter((l) => l.includes("gemini_safety_settings_refused"));
  expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "gemini_safety_settings_refused", status: 400 }]);
  expect(warned.join("\n")).not.toContain("secret");
});

test("a block by Google's own fixed filter is a plain message with no model and no prompt, billed as not charged; an ordinary decline stays an ordinary decline", async () => {
  const blocks: [string, unknown][] = [
    ["a blocked prompt", { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }],
    ["an image-safety finish", { candidates: [{ finishReason: "IMAGE_SAFETY" }] }],
    ["a safety finish in a step", { steps: [{ type: "model_output", finish_reason: "SAFETY", content: [] }] }],
    ["a blocklist finish", { promptFeedback: { blockReason: "BLOCKLIST" } }],
  ];
  await withDoor("google", async () => {
    for (const [label, body] of blocks) {
      const { lib } = gemini([{ body }]);
      const error = await lib.generateImage(ask).catch((e) => e);
      expect(error, label).toBeInstanceOf(lib.SafetyBlockError);
      expect(error.message, label).toBe(SAFETY_BLOCK_MESSAGE);
      expect(error.message).not.toMatch(/gemini|google|nano|banana|harbour|secret/i);
      expect(error.outcome, label).toMatchObject({ kind: "content_filter", billing: { state: "not_charged", basis: "safety-block" } });
      expect(typeof error.reason).toBe("string");
    }
    /* No code, only words: the model's own decline, as before. */
    const { lib } = gemini([{ body: { steps: [{ type: "model_output", content: [{ type: "text", text: "I can't draw that." }] }] } }]);
    const declined = await lib.generateImage(ask).catch((e) => e);
    expect(declined).toBeInstanceOf(lib.StillRefusalError);
    expect(declined).not.toBeInstanceOf(lib.SafetyBlockError);
    expect(declined.message).not.toMatch(/GOOGLE_SAFETY_THRESHOLD/);
  });
  await withDoor("gateway", async () => {
    const { lib } = gemini([{ body: { choices: [{ finish_reason: "content_filter", message: { content: "" } }], usage: { cost: 0.02 } } }]);
    const error = await lib.generateImage(ask).catch((e) => e);
    expect(error).toBeInstanceOf(lib.SafetyBlockError);
    expect(error.message).toBe(SAFETY_BLOCK_MESSAGE);
  });
});

test("the block reasons are read from the provider's own codes only, and the log line holds the event, the reason and the take's id, never a word of the prompt or the output", () => {
  for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "SPII", "RECITATION"])
    expect(geminiBlockReason({ promptFeedback: { blockReason: reason } }), reason).toBe(reason);
  expect(geminiBlockReason({ choices: [{ finish_reason: "content_filter" }] })).toBe("CONTENT_FILTER");
  expect(geminiBlockReason({ candidates: [{ finishReason: "STOP" }] })).toBeNull();
  expect(geminiBlockReason({ choices: [{ finish_reason: "stop", message: { content: "SAFETY" } }] })).toBeNull();
  expect(geminiBlockReason({ steps: [{ content: [{ type: "text", text: "PROHIBITED_CONTENT" }] }] })).toBeNull();
  expect(geminiBlockReason(null)).toBeNull();
  expect(JSON.parse(safetyBlockLog("IMAGE_SAFETY", "gen_123"))).toEqual({ event: "gemini_safety_block", reason: "IMAGE_SAFETY", generationId: "gen_123" });
  expect(JSON.parse(safetyBlockLog("a free text that is not a code, with the prompt", null))).toEqual({ event: "gemini_safety_block", reason: "blocked", generationId: null });
  expect(SAFETY_BLOCK_MESSAGE).not.toMatch(/gemini|google|nano|banana/i);
  expect(TEXT_SAFETY_BLOCK_MESSAGE).not.toMatch(/gemini|google/i);
});

/* ── A blocked take settles at nothing, through the existing failure path ── */

function workspace(name: string, platformKeys: boolean): TenantWorkspace {
  return { id: `ws_${name}`, slug: name, name, legacy: !platformKeys, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: platformKeys, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}

test("a take Google's fixed filter blocked fails with the plain message, free (nothing is charged to it), and logs only the reason and the take's id", async () => {
  process.env.ENGINE_MOCK = "1";
  const { produce } = await import("../../lib/renderWork");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { engineFor } = await import("../../lib/engines");
  const { SafetyBlockError } = await import("../../lib/gemini");
  const { safetyBlockOutcome } = await import("../../lib/providerOutcome");
  const engine = engineFor("google"); const original = engine.render;
  engine.render = async () => { throw new SafetyBlockError("PROHIBITED_CONTENT", safetyBlockOutcome("google", "PROHIBITED_CONTENT")); };
  const logged: string[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  const row = async (id: string) => (await db().execute({ sql: "SELECT status, error, cost_usd, provider_outcome FROM generations WHERE id=?", args: [id] })).rows[0];
  try {
    await runInTenant(workspace("gemini-safety-block", false), async () => {
      await ready();
      for (const id of ["gen_blocked", "gen_declined"])
        await db().execute({ sql: `INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'image','gemini-3-pro-image','a private secret word','{}','running',0,0)`, args: [id] });
      const job = (genId: string) => ({ genId, kind: "image" as const, modelId: "gemini-3-pro-image", prompt: "a private secret word", ratio: "1:1", size: "1K", references: [], startedAt: 0 });
      await expect(produce(job("gen_blocked"))).rejects.toThrow(SAFETY_BLOCK_MESSAGE);
      const blocked = await row("gen_blocked");
      expect(blocked.status).toBe("failed");
      expect(blocked.error).toBe(SAFETY_BLOCK_MESSAGE);
      expect(Number(blocked.cost_usd ?? 0)).toBe(0);
      expect(JSON.parse(String(blocked.provider_outcome))).toMatchObject({ kind: "content_filter", billing: { state: "not_charged", basis: "safety-block" } });
      /* An ordinary decline (no block code) keeps the vendor's estimate, as before. */
      const { StillRefusalError } = await import("../../lib/gemini");
      const { googleRefusalOutcome } = await import("../../lib/providerOutcome");
      engine.render = async () => { throw new StillRefusalError("declined", googleRefusalOutcome(null, null)); };
      await expect(produce(job("gen_declined"))).rejects.toThrow("declined");
      expect(Number((await row("gen_declined")).cost_usd ?? 0)).toBeGreaterThan(0);
    });
  } finally { engine.render = original; console.warn = warn; }
  const lines = logged.filter((l) => l.includes("gemini_safety_block"));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({ event: "gemini_safety_block", reason: "PROHIBITED_CONTENT", generationId: "gen_blocked" });
  expect(logged.join("\n")).not.toContain("secret");
});

test("a free failure releases the reservation through the existing meter: the credits held for a blocked take come back", async () => {
  const { fundFixtureWorkspace } = await import("../helpers/fundFixtureWorkspace");
  const { failJob } = await import("../../lib/renderWork");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { creditsUsed } = await import("../../lib/meter");
  const { safetyBlockOutcome } = await import("../../lib/providerOutcome");
  await runInTenant(workspace("gemini-safety-release", true), async () => {
    await fundFixtureWorkspace();
    await ready();
    await db().execute(`INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES('gen_gemini_safety_release','image','gemini-3-pro-image','p','{}','running',0,0)`);
    await reserveGenerationSpend({ id: "gen_gemini_safety_release", kind: "image", engine: "google", model: "gemini-3-pro-image", status: "running", engineCostUsd: 0.134 });
    expect(await creditsUsed("ws_gemini-safety-release")).toBeGreaterThan(0);
    await failJob("gen_gemini_safety_release", SAFETY_BLOCK_MESSAGE, true, safetyBlockOutcome("google", "SAFETY"));
    expect(await creditsUsed("ws_gemini-safety-release")).toBe(0);
  });
});

/* ── Text ── */

async function text(reply: unknown) {
  const saved = { m: process.env.ENGINE_MOCK, d: process.env.TEXT_DIRECT, k: process.env.GEMINI_API_KEY };
  delete process.env.ENGINE_MOCK; process.env.TEXT_DIRECT = "google"; process.env.GEMINI_API_KEY = "test-key-not-real";
  const sent: Record<string, unknown>[] = [];
  const warned: string[] = []; const warn = console.warn; console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    const { textPost } = await import("../../lib/textDirect");
    const { languageAuth } = await import("../../lib/language-provider");
    const model = "google/gemini-3.5-flash";
    const result = await textPost(JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "a private secret word" }] }), {
      auth: await languageAuth(model),
      fetch: (async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch,
    });
    return { result, sent, warned };
  } finally {
    console.warn = warn;
    for (const [k, v] of [["ENGINE_MOCK", saved.m], ["TEXT_DIRECT", saved.d], ["GEMINI_API_KEY", saved.k]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const answer = (finishReason: string, parts: unknown[] = [{ text: "Hello." }]) => ({ candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } });

test("a Gemini language request carries the four categories at BLOCK_NONE, direct", async () => {
  const { result, sent } = await text(answer("STOP"));
  expect(result.ok, result.text).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0].safetySettings).toEqual(FOUR);
});

test("a language answer Google's fixed filter blocked is a plain 422 with nothing charged, and only the reason is logged", async () => {
  for (const [label, reply] of [["a safety finish", answer("SAFETY", [])], ["a prohibited-content finish", answer("PROHIBITED_CONTENT", [])], ["a blocked prompt", { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }]] as const) {
    const { result, warned } = await text(reply);
    expect([label, result.ok, result.status], label).toEqual([label, false, 422]);
    expect(JSON.parse(result.text).error.message, label).toBe(TEXT_SAFETY_BLOCK_MESSAGE);
    const lines = warned.filter((l) => l.includes("gemini_safety_block"));
    expect(lines, label).toHaveLength(1);
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(["event", "generationId", "reason"]);
    expect(warned.join("\n")).not.toContain("secret");
  }
  const { result } = await text(answer("MAX_TOKENS", [{ text: "Cut" }]));
  expect(result.ok).toBe(true);
});
