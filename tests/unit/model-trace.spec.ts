import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { CatalogModel } from "../../lib/catalog";
import type { TenantWorkspace } from "../../lib/tenant";
import { MODEL_CALL_FILES } from "../helpers/modelCallSites";
import { LOW, MEDIUM } from "../helpers/thinkingSlots";
import { DIRECT_MODEL_IDS } from "../../lib/textRoute";

/**
 * Langfuse tracing (lib/modelTrace.ts), run: every listed model call site under ENGINE_MOCK or a scripted model,
 * traced to an in-memory exporter. Each call is one span carrying every required key; the outcome is right for an
 * answer, a refusal, a failure and a timeout; a canary prompt and a canary answer never reach a span; nothing but
 * model spans is exported. Then the real Langfuse processor against a stub server on this machine: nothing is sent
 * unless LANGFUSE_ENABLED is exactly "1", and what is sent carries no canary. The keys are synthetic, built here.
 * Nothing reaches a provider or Langfuse.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-model-trace-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";
delete process.env.PLATFORM_ALLOWANCE_USD;
delete process.env.LIVEBLOCKS_SECRET_KEY;
delete process.env.LANGFUSE_ENABLED;
process.env.LANGFUSE_ENVIRONMENT = "unit-test";

/** Text that must never leave in a span: put into every prompt, and into answers where the test writes the answer. */
const PROMPT_CANARY = "CANARY_PROMPT_q7Zx41";
const OUTPUT_CANARY = "CANARY_OUTPUT_m3Kp92";
/** Synthetic Langfuse keys for the stub server, never real ones. */
const SYNTHETIC_PUBLIC = "pk-lf-synthetic-unit-test-public";
const SYNTHETIC_SECRET = "sk-lf-synthetic-unit-test-secret";

const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
/** A made-up rate for the fixture writer, not any vendor's price: a run only needs a model with a price. */
const SYNTHETIC_RATE = { input: "0.00000111", output: "0.00000222" };
const WRITER: CatalogModel = { id: LOW, name: "Writer", owner: "anthropic", type: "language", description: "", contextWindow: 100000, maxTokens: 5000, pricing: SYNTHETIC_RATE };

const exporter = new InMemorySpanExporter();
const META = "langfuse.observation.metadata";

test.beforeAll(async () => {
  const { installModelSpanProcessors } = await import("../../lib/modelTraceExport");
  installModelSpanProcessors([new SimpleSpanProcessor(exporter)]);
});
test.afterAll(async () => { (await import("../../lib/modelTrace")).installModelTracer(null); });
test.beforeEach(() => exporter.reset());
/* After every test: no canary anywhere in what was exported, and only model spans. */
test.afterEach(() => {
  for (const span of exporter.getFinishedSpans()) {
    expect(span.instrumentationScope.name).toBe("particl.model");
    expect(["model.call", "model.step"]).toContain(span.name);
    const seen = JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links, resource: span.resource.attributes });
    expect(seen).not.toContain(PROMPT_CANARY);
    expect(seen).not.toContain(OUTPUT_CANARY);
  }
});

type Call = { site: string; meta: Record<string, unknown>; span: ReadableSpan };
function calls(): Call[] {
  return exporter.getFinishedSpans().filter((s) => s.name === "model.call").map((span) => ({
    site: String(span.attributes["langfuse.trace.name"]), meta: JSON.parse(String(span.attributes[META])) as Record<string, unknown>, span,
  }));
}
async function keys() { return (await import("../../lib/modelTrace")).MODEL_CALL_KEYS; }
/** Every call of `site`: each with every required key, at the expected outcome, in `workspace` when given; and no unattributed call. */
async function expectCalls(site: string, outcome: string, opts: { count?: number; workspace?: string } = {}) {
  const all = calls();
  expect(all.filter((c) => c.site === "unattributed").map((c) => c.meta), "a listed site never leaves an unattributed call").toEqual([]);
  const mine = all.filter((c) => c.site === site);
  if (opts.count !== undefined) expect(mine).toHaveLength(opts.count);
  else expect(mine.length).toBeGreaterThan(0);
  for (const call of mine) {
    expect(Object.keys(call.meta).sort()).toEqual([...(await keys())].sort());
    expect(call.meta.site).toBe(site);
    expect(call.meta.outcome).toBe(outcome);
    expect(call.meta.environment).toBe("unit-test");
    expect(typeof call.meta.latency_ms).toBe("number");
    if (opts.workspace) expect(call.meta.workspace_id).toBe(opts.workspace);
    expect(call.span.attributes["langfuse.observation.type"]).toBe("generation");
    expect(call.span.attributes["langfuse.trace.tags"]).toContain(site);
    expect(call.span.attributes["user.id"]).toBeUndefined();
  }
  return mine;
}

let seq = 0;
async function inWorkspace<T>(fn: (ws: TenantWorkspace) => Promise<T>): Promise<T> {
  const id = `ws_trace_${++seq}_${randomUUID().slice(0, 8)}`;
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,500)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 10000, "Trace test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  return runInTenant(ws, async () => { await ready(); return fn(ws); }, OWNER);
}

/* ── The wrapper itself ───────────────────────────────────────────────── */

test("one span per call, at the right outcome: answered, refused (provider 4xx or a filter), failed, timed out; a door inside a door is the same call", async () => {
  const { traceModelCall, modelDoor, readTextReply } = await import("../../lib/modelTrace");
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: JSON.stringify(body) });
  const answered = { choices: [{ message: { content: OUTPUT_CANARY }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, cost: 0.0042 } };
  const door = (r: { ok: boolean; status: number; text: string }) => modelDoor(() => modelDoor(async () => r, readTextReply), readTextReply);

  expect(await traceModelCall("atomik.ideas", { runId: "run_1", step: "idea", model: "test/model", effort: "low" }, () => door(reply(200, answered)))).toMatchObject({ status: 200 });
  await traceModelCall("atomik.ideas", {}, () => door(reply(429, { error: { message: PROMPT_CANARY } })));
  await traceModelCall("atomik.ideas", {}, () => door(reply(200, { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] })));
  await traceModelCall("atomik.ideas", {}, () => door(reply(503, { error: { message: PROMPT_CANARY } })));
  await expect(traceModelCall("atomik.ideas", {}, () => modelDoor(async () => { throw new DOMException(PROMPT_CANARY, "TimeoutError"); }))).rejects.toThrow(PROMPT_CANARY);
  await expect(traceModelCall("atomik.ideas", {}, async () => { await door(reply(200, answered)); throw new Error(`unusable ${OUTPUT_CANARY}`); })).rejects.toThrow();

  const out = calls();
  expect(out.map((c) => c.meta.outcome)).toEqual(["answered", "refused", "refused", "failed", "timed_out", "failed"]);
  expect(out[0].meta).toMatchObject({ run_id: "run_1", step: "idea", model: "test/model", effort: "low", tokens_in: 120, tokens_out: 30, tokens_cached: 100, vendor_cost_usd: 0.0042, sent: true, attempts: 1, mode: null, band: null, chat_id: null, workspace_id: null });
  expect(JSON.parse(String(out[0].span.attributes["langfuse.observation.usage_details"]))).toEqual({ input: 120, output: 30, input_cached_tokens: 100 });
  expect(JSON.parse(String(out[0].span.attributes["langfuse.observation.cost_details"]))).toEqual({ total: 0.0042 });
  expect(out[0].span.attributes["session.id"]).toBe("run_1");
  /* The error text is never kept: only the outcome, the status and the error's class name. */
  expect(out[4].span.attributes["langfuse.observation.status_message"]).toBe("timed_out error=TimeoutError");
  expect(out[1].span.attributes["langfuse.observation.status_message"]).toBe("refused status=429");
});

test("a door with no site around it is still traced, as unattributed; tracing off changes nothing a call returns or throws", async () => {
  const { modelDoor, installModelTracer, traceModelCall, modelTracingOn, modelTelemetry } = await import("../../lib/modelTrace");
  expect(await modelDoor(async () => 7)).toBe(7);
  expect(calls().map((c) => c.site)).toEqual(["unattributed"]);
  expect(modelTelemetry("x")).toMatchObject({ isEnabled: true, recordInputs: false, recordOutputs: false, functionId: "x" });
  exporter.reset();
  const { installModelSpanProcessors } = await import("../../lib/modelTraceExport");
  installModelTracer(null);
  try {
    expect(modelTracingOn()).toBe(false);
    expect(modelTelemetry("x")).toEqual({ isEnabled: false, recordInputs: false, recordOutputs: false, functionId: "x" });
    expect(await traceModelCall("atomik.ideas", {}, () => modelDoor(async () => "same"))).toBe("same");
    const thrown = new Error("same error");
    await expect(traceModelCall("atomik.ideas", {}, async () => { throw thrown; })).rejects.toBe(thrown);
    expect(exporter.getFinishedSpans()).toEqual([]);
  } finally { installModelSpanProcessors([new SimpleSpanProcessor(exporter)]); }
});

/* ── Through the real text door, with a stub transport (no ENGINE_MOCK) ── */

const anthropicReply = (text: string) => ({ id: "msg_fixture", type: "message", role: "assistant", model: DIRECT_MODEL_IDS[LOW], content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 60, output_tokens: 25 } });
async function snapshot(id: string): Promise<CatalogModel> {
  const { snapshotModels } = await import("../../lib/catalog");
  const found = snapshotModels().find((model) => model.id === id);
  if (!found) throw new Error(`${id} is not in the snapshot`);
  const { providerId, ...model } = found;
  void providerId;
  return model;
}

test("the memory read through textPost to a direct vendor: answered with its tokens and vendor cost; a 400 refused, a 500 failed, a timeout timed out", async () => {
  const saved = { mock: process.env.ENGINE_MOCK, direct: process.env.TEXT_DIRECT, key: process.env.ANTHROPIC_API_KEY };
  delete process.env.ENGINE_MOCK;
  process.env.TEXT_DIRECT = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-synthetic-never-sent";
  try {
    const model = await snapshot(LOW);
    const { runMemoryRead } = await import("../../lib/atomikMemoryRead");
    const { textPost } = await import("../../lib/textDirect");
    const via = (respond: () => Response) => ({
      model, submit: (req: { body: string; auth?: Record<string, string> }) => textPost(req.body, { auth: req.auth, fetch: async (url) => {
        expect(new URL(String(url)).origin).toBe("https://api.anthropic.com");
        return respond();
      } }),
    });
    await inWorkspace(async (ws) => {
      const read = (respond: () => Response) => runMemoryRead({ text: `Our brand voice is calm. ${PROMPT_CANARY}`, model: model.id, maxCredits: 1000, projectId: null, createdBy: "owner" }, via(respond));
      const answered = await read(() => Response.json(anthropicReply(JSON.stringify({ entries: [{ kind: "note", text: `Keep it calm ${OUTPUT_CANARY}.` }] }))));
      expect(answered.read.entries.length).toBe(1);
      const [call] = await expectCalls("atomik.memory_read", "answered", { count: 1, workspace: ws.id });
      expect(call.meta).toMatchObject({ run_id: answered.id, model: model.id, tokens_in: 160, tokens_out: 25, tokens_cached: 60, sent: true, step: "memory" });
      expect(call.meta.vendor_cost_usd).toBeCloseTo(answered.costUsd, 12);
      expect(Number(call.meta.vendor_cost_usd)).toBeGreaterThan(0);

      exporter.reset();
      await expect(read(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: `bad ${PROMPT_CANARY}` } }, { status: 400 }))).rejects.toThrow();
      await expectCalls("atomik.memory_read", "refused", { count: 1, workspace: ws.id });
      exporter.reset();
      await expect(read(() => Response.json({ type: "error", error: { type: "api_error", message: "down" } }, { status: 500 }))).rejects.toThrow();
      await expectCalls("atomik.memory_read", "failed", { count: 1, workspace: ws.id });
      exporter.reset();
      await expect(read(() => { throw new DOMException("The operation timed out.", "TimeoutError"); })).rejects.toThrow();
      await expectCalls("atomik.memory_read", "timed_out", { count: 1, workspace: ws.id });
    });
  } finally {
    if (saved.mock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = saved.mock;
    if (saved.direct === undefined) delete process.env.TEXT_DIRECT; else process.env.TEXT_DIRECT = saved.direct;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  }
});

test("a refusal before anything is sent is refused with sent false: TextNotSentError at a door, and a direct request the door will not send", async () => {
  const { traceModelCall, modelDoor, readTextReply } = await import("../../lib/modelTrace");
  const { TextNotSentError, textPost } = await import("../../lib/textDirect");
  await expect(traceModelCall("atomik.ideas", {}, () => modelDoor(async () => { throw new TextNotSentError(`not sendable ${PROMPT_CANARY}`); }))).rejects.toThrow(TextNotSentError);
  const saved = { mock: process.env.ENGINE_MOCK, direct: process.env.TEXT_DIRECT, key: process.env.ANTHROPIC_API_KEY };
  delete process.env.ENGINE_MOCK;
  process.env.TEXT_DIRECT = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-synthetic-never-sent";
  try {
    let fetched = 0;
    /* No max_tokens: the direct door refuses it before sending (lib/textDirect.ts directTextRequest). */
    const body = JSON.stringify({ model: LOW, messages: [{ role: "user", content: PROMPT_CANARY }] });
    const reply = await traceModelCall("atomik.ideas", {}, () => textPost(body, { fetch: async () => { fetched++; return new Response("{}"); } }));
    expect(reply.status).toBe(422);
    expect(fetched).toBe(0);
    /* A provider's own 4xx, for contrast: sent. */
    await traceModelCall("atomik.ideas", {}, () => modelDoor(async () => ({ ok: false, status: 400, text: "{}" }), readTextReply));
  } finally {
    if (saved.mock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = saved.mock;
    if (saved.direct === undefined) delete process.env.TEXT_DIRECT; else process.env.TEXT_DIRECT = saved.direct;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  }
  expect(calls().map((c) => [c.meta.outcome, c.meta.sent, c.meta.attempts])).toEqual([["refused", false, 0], ["refused", false, 0], ["refused", true, 1]]);
});

/* ── Every listed site, under ENGINE_MOCK or a scripted model ─────────── */

test("atomik.memory_read under ENGINE_MOCK", async () => {
  await inWorkspace(async (ws) => {
    const { runMemoryRead } = await import("../../lib/atomikMemoryRead");
    await runMemoryRead({ text: `The brand is calm. ${PROMPT_CANARY}`, model: WRITER.id, maxCredits: 1000, projectId: null, createdBy: "owner" }, { model: WRITER });
    await expectCalls("atomik.memory_read", "answered", { count: 1, workspace: ws.id });
  });
});

/** Network closed except for a canned gateway catalogue holding one Atomik planner (as tests/unit/atomikKeySteps.spec.ts). */
async function withCatalogue<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models") && url.includes("ai-gateway.vercel.sh"))
      return new Response(JSON.stringify({ data: [{ id: MEDIUM, name: "Claude", type: "language", context_window: 200000, max_tokens: 8000,
        pricing: SYNTHETIC_RATE, modalities: { input: ["text", "image"], output: ["text"] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Network is forbidden in the trace test: ${url}`);
  }) as typeof fetch;
  try {
    const { catalog } = await import("../../lib/catalog");
    await catalog(true);
    return await fn();
  } finally { globalThis.fetch = real; }
}

test("atomik.turn: a chat turn carries its chat id", async () => {
  await inWorkspace((ws) => withCatalogue(async () => {
    const atomik = await import("../../lib/atomik");
    const chatId = await atomik.createChat({ userId: "owner", projectId: null, model: "auto", agentMode: "ask" });
    await atomik.addUserMessage(chatId, `Plan a calm harbour film. ${PROMPT_CANARY}`);
    await atomik.runTurn(chatId, {});
    const [call] = await expectCalls("atomik.turn", "answered", { count: 1, workspace: ws.id });
    expect(call.meta).toMatchObject({ chat_id: chatId, step: "turn" });
    expect(call.span.attributes["session.id"]).toBe(chatId);
  }));
});

/* The routes, compiled as they ship, with the session and the catalogue answered here; paid text, the claim and the meter real. */
const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => (name in overrides ? overrides[name] : name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name)),
    target, target.exports,
  );
  return target.exports as T;
}
type Handler = (req: Request) => Promise<Response>;
const post = (url: string, body: unknown, key = randomUUID()) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

function routeModules() {
  const paidText = nodeRequire(path.resolve("lib/paidText.ts"));
  return {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (h: unknown) => h, requireRender: async () => OWNER },
    "@/lib/catalog": { ...nodeRequire(path.resolve("lib/catalog.ts")), catalog: async () => [WRITER] },
    "@/lib/language-provider": { languageReachable: () => true },
    "@/lib/atomik": { ...nodeRequire(path.resolve("lib/atomik.ts")), requestEffort: () => undefined, resolveModel: async () => WRITER.id },
    "@/lib/atomikDocs": { ...nodeRequire(path.resolve("lib/atomikDocs.ts")), getTreatment: async () => ({ logline: `A courier ${PROMPT_CANARY}`, setup: {}, scenes: [{ n: 1, title: "Platform", secs: 12, prose: "Rain on the platform." }], updatedAt: 1 }) },
    "@/lib/cast": { listCast: async () => [] },
    "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => null },
    "@/lib/generationRequests": { ...nodeRequire(path.resolve("lib/generationRequests.ts")), withGenerationRequest: (_req: Request, _user: string, run: () => Promise<Response>) => run() },
    /* The real paid-text path, its model the fixture's: the site's trace field is the route's own. */
    "@/lib/paidText": { ...paidText, runPaidText: (input: unknown, o: Record<string, unknown> = {}) => paidText.runPaidText(input, { ...o, model: WRITER }) },
    "next/server": { NextResponse: Response, after: () => {} },
  };
}

for (const [site, route, body] of [
  ["atomik.ideas", "app/api/atomik/ideas/draft/route.ts", { brief: `A calm harbour. ${PROMPT_CANARY}`, maxCredits: 1000 }],
  ["atomik.shots", "app/api/atomik/shots/draft/route.ts", { projectId: "p1", scene: 1, maxCredits: 1000 }],
  ["atomik.treatment_scene", "app/api/atomik/treatment/scene/route.ts", { projectId: "p1", n: 1, note: PROMPT_CANARY, maxCredits: 1000 }],
] as const) test(`${site}: the route's paid-text job is its site`, async () => {
  await inWorkspace(async (ws) => {
    const { POST } = load<{ POST: Handler }>(route, routeModules());
    const res = await POST(post(`http://localhost/${route}`, body));
    expect(res.status, await res.clone().text()).toBeLessThan(500);
    const [call] = await expectCalls(site, "answered", { count: 1, workspace: ws.id });
    expect(call.meta.model).toBe(WRITER.id);
  });
});

test("atomik.enhance: the prompt enhancer", async () => {
  await inWorkspace(async (ws) => {
    const { POST } = load<{ POST: Handler }>("app/api/prompt/enhance/route.ts", routeModules());
    const res = await POST(post("http://localhost/api/prompt/enhance", { prompt: `a tree in rain ${PROMPT_CANARY}`, mode: "video", provider: "claude", maxCredits: 5 }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [call] = await expectCalls("atomik.enhance", "answered", { count: 1, workspace: ws.id });
    expect(call.meta).toMatchObject({ step: "video", effort: "quick" });
  });
});

test("enhance.inline: the prompt writer before a render", async () => {
  await inWorkspace(async (ws) => {
    const { enhancePrompt } = await import("../../lib/enhance");
    const written = await enhancePrompt({ prompt: `a lighthouse at dusk ${PROMPT_CANARY}`, citations: [], task: "generate" });
    expect(written.text.length).toBeGreaterThan(0);
    await expectCalls("enhance.inline", "answered", { count: 1, workspace: ws.id });
  });
});

test("atomik.board_planner: the planning turn, with one child span per model step from the AI SDK's telemetry hook", async () => {
  const OWNER_ID = "ana";
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { newProject } = await import("../../lib/workbench/studio");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } = await import("../../lib/workbench/rig-agent-planner");
  const agent = await import("../../lib/workbench/rig-agent");
  await platformReady();
  const id = `ws_trace_rig_${randomUUID().slice(0, 8)}`;
  await platformDb().execute({ sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,0,0,20,500)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, OWNER_ID] });
  await grantCredits(id, 2000, "Test", OWNER_ID, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  const user = { id: OWNER_ID, email: "ana@example.invalid", name: "Ana", role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null };
  await runInTenant(ws, async () => {
    await ready();
    const project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1", boardMode: { [OWNER_ID]: "director" as const } };
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${OWNER_ID}:draft-1`, OWNER_ID, "draft-1", "Harbour", JSON.stringify(project)] });
    await patchTeamCanvas("prod-1", { upsertNodes: [], removeNodes: [], upsertAssets: [], order: [] }, OWNER_ID);
    const asked = await agent.askRigAgent({ productionId: "prod-1", draftId: "draft-1", userId: OWNER_ID, requestId: `req-trace-${randomUUID()}`, goal: `The captain on the pier, two shots. ${PROMPT_CANARY}`, limit: 50 });
    const deps = {
      access: async () => null, paceMs: 0,
      plan: async (snap: Parameters<typeof runPlanner>[0]) => ({ ...(await runPlanner(snap, mockPlannerModel(snap))), model: MOCK_PLANNER_MODEL }),
      pricing: async () => ({ id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false }),
    };
    expect(await agent.advanceRigAgentRun(asked.id, deps as never)).toEqual({ state: "awaiting_approval", more: false });
    const [call] = await expectCalls("atomik.board_planner", "answered", { count: 1, workspace: id });
    expect(call.meta).toMatchObject({ run_id: asked.id, step: "plan", band: 1, mode: "director", model: MOCK_PLANNER_MODEL, sent: true });
    expect(Number(call.meta.tokens_in)).toBeGreaterThan(0);
    expect(Number(call.meta.vendor_cost_usd)).toBeGreaterThan(0);
    const steps = exporter.getFinishedSpans().filter((s) => s.name === "model.step");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) {
      expect(step.parentSpanContext?.spanId).toBe(call.span.spanContext().spanId);
      expect(step.attributes["langfuse.observation.type"]).toBe("span");
      expect(Object.keys(JSON.parse(String(step.attributes[META]))).sort()).toEqual(["finish_reason", "latency_ms", "model", "site", "tokens_cached", "tokens_in", "tokens_out"]);
    }
  }, { user } as never);
});

function testWorkspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: "unit", name: "Unit", legacy: false, dbUrl: "file:" + path.join(dir, id + ".db"), dbToken: null,
    keys: { gateway: "test-only-never-sent" }, usesPlatformKeys: false, allowanceUsd: null,
    gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace;
}
const DEV_MODEL: CatalogModel = { id: MEDIUM, name: "Claude", owner: "anthropic", type: "language", inputModalities: ["text", "image"], description: "", contextWindow: 200000, maxTokens: 8192, pricing: { input: "0.0000001", output: "0.0000003" } };

test("atomik.development: one call per phase, step = kind and stage", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { seedProject } = await import("../../lib/workbench/studio");
  const { fundFixtureWorkspace } = await import("../helpers/fundFixtureWorkspace");
  const dev = await import("../../lib/workbench/development-server");
  const ws = testWorkspace();
  await runInTenant(ws, async () => {
    await ready(); await fundFixtureWorkspace();
    const project = seedProject(); project.id = "development-" + randomUUID(); project.productionProjectId = "real-" + randomUUID();
    project.script = "TITLE PAGE\n\nEXT. DUNES - DAY\nWren follows her reflection.";
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: ["owner:" + project.id, "owner", project.id, project.name, JSON.stringify(project), Date.now()] });
    const deps: Partial<import("../../lib/workbench/development-server").DevelopmentDependencies> = {
      models: async () => [DEV_MODEL], allowance: async () => ({ ok: true }) as never,
      auth: async () => ({ token: "test-only-not-sent", method: "api-key" }) as never, funding: async () => {}, reservation: async () => true,
      reserve: async () => {}, meter: async () => {},
      call: async (input) => ({ text: JSON.stringify(input.stage === "critique" ? { issues: [`Check ${OUTPUT_CANARY}.`], revisions: ["Keep it."] } : {
        summary: `Plan ${OUTPUT_CANARY}`, recommendation: "Motivated camera.", ideas: [],
        scenes: input.chunk.segments.map((s) => ({ id: s.id, heading: s.heading, sourceStart: s.start, sourceEnd: s.end, summary: "Action.", beats: ["Need."],
          shots: [{ description: "Wide.", framing: "Wide", movement: "Locked", lighting: "Key", sound: "Tone" }], characters: [], props: [], locations: [], productionNotes: [] })),
        critique: ["Ok."], assumptions: ["Ok."] }), inputTokens: 200, outputTokens: 100, costUsd: 0.002 }),
    };
    const request = { projectId: project.id, requestId: randomUUID(), kind: "screenplay" as const, model: DEV_MODEL.id, effort: "auto", instructions: `Make this shootable. ${PROMPT_CANARY}` };
    const quote = await dev.quoteDevelopmentJob(request, "owner", deps);
    const job = await dev.prepareDevelopmentJob({ ...request, sourceHash: quote.sourceHash, maxCredits: quote.estimateCredits, maxUsd: quote.estimateUsd }, "owner", undefined, deps);
    for (let i = 0; i < 6; i++) if ((await dev.runDevelopmentStep(job.job.id, "owner", deps)).done) break;
    const traced = await expectCalls("atomik.development", "answered", { workspace: ws.id });
    expect(traced.map((c) => c.meta.step)).toEqual(expect.arrayContaining(["screenplay:draft"]));
    for (const c of traced) expect(c.meta).toMatchObject({ run_id: job.job.id, tokens_in: 200, tokens_out: 100, vendor_cost_usd: 0.002, model: DEV_MODEL.id });
  });
});

test("atomik.workbench: a Studio Atomik job", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { seedProject } = await import("../../lib/workbench/studio");
  const server = await import("../../lib/workbench/atomik-server");
  const ws = testWorkspace();
  await runInTenant(ws, async () => {
    await ready();
    const project = seedProject(); project.id = "production-" + randomUUID(); project.productionProjectId = "real-project-" + randomUUID();
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: ["owner:" + project.id, "owner", project.id, project.name, JSON.stringify(project), Date.now()] });
    const input = server.atomikRequestSchema.parse({ projectId: project.id, requestId: randomUUID(), request: `Make a shot proposal ${PROMPT_CANARY}`, model: "auto", depth: "Quick", refs: [] });
    const reply = { intent: "shots", summary: `A summary ${OUTPUT_CANARY}`, steps: ["Open wide."] };
    const deps: import("../../lib/workbench/atomik-server").AtomikDependencies = {
      assertFunding: async () => {}, runAstra: async () => { throw new Error("no"); }, runSuite: async () => { throw new Error("no"); },
      models: async () => [DEV_MODEL], allowance: async () => ({ ok: true }) as never,
      limits: async () => ({ allow: true, limits: { concurrency: 3, rendersPerHour: 30, storageBytes: 1000000 }, standing: { running: 0, startedLastHour: 0, usedBytes: 0 } }) as never,
      reserve: async () => {}, meter: async () => {}, auth: async () => ({}),
      /* Through the real door, its reply written here. */
      run: async () => {
        const { modelDoor, readTextReply } = await import("../../lib/modelTrace");
        return modelDoor(async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 210, completion_tokens: 60, cost: 0.003 } }) }), readTextReply);
      },
    } as never;
    const prepared = await server.prepareAtomikJob(input, "owner", undefined, deps);
    await server.runAtomikJob(prepared.job.id, "owner", deps);
    const [call] = await expectCalls("atomik.workbench", "answered", { count: 1, workspace: ws.id });
    expect(call.meta).toMatchObject({ run_id: prepared.job.id, step: "plan", tokens_in: 210, tokens_out: 60, vendor_cost_usd: 0.003, sent: true });
  });
});

test("crew.round: one call per member and phase", async () => {
  const { platformReady, platformDb, getWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { createSession, claimRound, listMembers } = await import("../../lib/crew/store");
  const { DEFAULT_CONTEXT } = await import("../../lib/crew/room");
  const { runRound, quoteRound } = await import("../../lib/crew/round");
  const { newProject } = await import("../../lib/workbench/studio");
  /* Crew's model, as the deployment names it (lib/crew/xai.ts), read here rather than written down. */
  const crewModel = (await import("../../lib/crew/xai")).xaiModel();
  await platformReady();
  const id = `crew_trace_${randomUUID().slice(0, 8)}`, owner = `owner_${id}`;
  await platformDb().batch([
    { sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,'unused',0)", args: [owner, `${owner}@example.test`, "Crew fixture"] },
    { sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at,uses_platform_keys) VALUES(?,?,?,?,?,0,0,1)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, owner] },
    { sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',0)", args: [id, owner] },
  ], "write");
  await grantCredits(id, 10000, "Crew fixture", null, "manual");
  const workspace = (await getWorkspace(id)) as TenantWorkspace;
  await runInTenant(workspace, async () => {
    await listMembers(owner, "trace-project");
    const session = await createSession(owner, { projectId: "trace-project", goal: `Find the ending ${PROMPT_CANARY}`, context: DEFAULT_CONTEXT, model: crewModel });
    expect(await claimRound(owner, session.id, 1)).toBe(true);
    const active = (await listMembers(owner, "trace-project")).slice(0, 2).map((m, i) => ({ ...m, isChair: i === 0 }));
    const project = { ...newProject("Trace"), brief: PROMPT_CANARY };
    const rate = { inputUsdPerToken: 0.000001, outputUsdPerToken: 0.000003 };
    const quote = quoteRound({ session, project, active, rate, transcriptChars: 0 });
    await runRound({ session, project, active, rate, ceilingUsd: quote.ceilingUsd, userId: owner, emit: () => {} });
    const traced = await expectCalls("crew.round", "answered", { workspace: id });
    expect(traced.length).toBeGreaterThanOrEqual(3);
    for (const c of traced) {
      expect(c.meta).toMatchObject({ chat_id: session.id, model: crewModel, sent: true });
      expect(Number(c.meta.vendor_cost_usd)).toBeGreaterThan(0);
    }
    expect(new Set(traced.map((c) => c.meta.step))).toEqual(new Set(["propose", "challenge", "converge"]));
  });
});

test("every listed site has a run in this file", () => {
  const source = readFileSync(__filename, "utf8");
  for (const site of MODEL_CALL_FILES.flatMap((e) => e.sites ?? [])) expect(source, site).toContain(`"${site}"`);
});

/* ── The real Langfuse processor, against a stub server on this machine ── */

type Received = { url: string; auth: string | undefined; body: string };
async function stubLangfuse(status = 200): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { received.push({ url: String(req.url), auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(status, { "Content-Type": "application/json" }); res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}
async function tracedRead() {
  const { traceModelCall, modelDoor, readTextReply } = await import("../../lib/modelTrace");
  return traceModelCall("atomik.memory_read", { runId: "run_stub", model: WRITER.id }, () => modelDoor(async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: OUTPUT_CANARY }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.0001 } }) }), readTextReply));
}

test("the Langfuse processor: nothing is sent unless LANGFUSE_ENABLED is exactly 1; sent, the trace has no canary and no Next.js span; an outage changes nothing", async () => {
  const { installModelTracer } = await import("../../lib/modelTrace");
  const { startLangfuseTracing, installModelSpanProcessors } = await import("../../lib/modelTraceExport");
  const stub = await stubLangfuse();
  const base = { LANGFUSE_PUBLIC_KEY: SYNTHETIC_PUBLIC, LANGFUSE_SECRET_KEY: SYNTHETIC_SECRET, LANGFUSE_BASE_URL: `http://127.0.0.1:${stub.port}`, LANGFUSE_ENVIRONMENT: "unit-test" };
  try {
    for (const enabled of [undefined, "true", "0", " 1", "yes", "1\n", "TRUE"]) {
      installModelTracer(null);
      expect(startLangfuseTracing({ ...base, ...(enabled === undefined ? {} : { LANGFUSE_ENABLED: enabled }) }), String(enabled)).toBeNull();
      expect((await tracedRead()).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.received).toEqual([]);

    const provider = startLangfuseTracing({ ...base, LANGFUSE_ENABLED: "1" });
    expect(provider).not.toBeNull();
    expect((await tracedRead()).status).toBe(200);
    /* A span from another library on the same provider (what Next.js's request span would be) is never exported. */
    provider!.getTracer("next.js").startSpan("GET /api/atomik/ideas/draft", { attributes: { "http.target": `/api/x?q=${PROMPT_CANARY}`, "next.span_type": "BaseServer.handleRequest" } }).end();
    await provider!.forceFlush();
    expect(stub.received.length).toBeGreaterThan(0);
    const sent = stub.received.map((r) => r.body).join("\n");
    expect(stub.received.every((r) => r.url === "/api/public/otel/v1/traces")).toBe(true);
    expect(stub.received[0].auth).toBe(`Basic ${Buffer.from(`${SYNTHETIC_PUBLIC}:${SYNTHETIC_SECRET}`).toString("base64")}`);
    expect(sent).toContain("atomik.memory_read");
    expect(sent).toContain("unit-test");
    expect(sent).not.toContain(PROMPT_CANARY);
    expect(sent).not.toContain(OUTPUT_CANARY);
    expect(sent).not.toContain("GET /api/atomik");
    expect(sent).not.toContain("next.js");
    await provider!.shutdown();

    /* Langfuse down (nothing listening): the call answers as before, and quickly. */
    const down = startLangfuseTracing({ ...base, LANGFUSE_ENABLED: "1", LANGFUSE_BASE_URL: "http://127.0.0.1:9" });
    const started = Date.now();
    expect((await tracedRead()).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    await down!.forceFlush().catch(() => {});
    await down!.shutdown().catch(() => {});
  } finally {
    await new Promise((resolve) => stub.server.close(resolve));
    installModelSpanProcessors([new SimpleSpanProcessor(exporter)]);
  }
});

test("enabled with a key missing or a base URL unusable: one log line with the names (never a value), tracing stays off", async () => {
  const { installModelTracer, modelTracingOn } = await import("../../lib/modelTrace");
  const { startLangfuseTracing, installModelSpanProcessors } = await import("../../lib/modelTraceExport");
  const logged: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    installModelTracer(null);
    expect(startLangfuseTracing({ LANGFUSE_ENABLED: "1", LANGFUSE_PUBLIC_KEY: SYNTHETIC_PUBLIC, LANGFUSE_BASE_URL: "https://cloud.langfuse.com" })).toBeNull();
    expect(startLangfuseTracing({ LANGFUSE_ENABLED: "1", LANGFUSE_PUBLIC_KEY: SYNTHETIC_PUBLIC, LANGFUSE_SECRET_KEY: SYNTHETIC_SECRET, LANGFUSE_BASE_URL: "http://langfuse.example.com" })).toBeNull();
    expect(modelTracingOn()).toBe(false);
    expect(logged).toHaveLength(2);
    expect(JSON.parse(logged[0])).toMatchObject({ event: "langfuse.not_started", missing: ["LANGFUSE_SECRET_KEY"], invalid: [] });
    expect(JSON.parse(logged[1])).toMatchObject({ event: "langfuse.not_started", missing: [], invalid: ["LANGFUSE_BASE_URL"] });
    expect(logged.join("\n")).not.toContain(SYNTHETIC_PUBLIC);
    expect(logged.join("\n")).not.toContain(SYNTHETIC_SECRET);
    expect((await tracedRead()).status).toBe(200);
  } finally {
    console.error = real;
    installModelSpanProcessors([new SimpleSpanProcessor(exporter)]);
  }
});
