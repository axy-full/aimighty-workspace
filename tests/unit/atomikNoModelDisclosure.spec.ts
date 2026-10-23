import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { HIGH, LOW, MEDIUM } from "../helpers/thinkingSlots";
import { thinkingModelNames } from "../helpers/uiStrings";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { loadRouteModule } from "../helpers/vendorCostScan";
import { VERIFIED_TEXT_MODEL_IDS, treatmentWriter } from "../../lib/atomikModelPolicy";
import { DIRECT_MODEL_IDS } from "../../lib/textRoute";
import { MODELS } from "../../lib/models";

/*
 * The owner, 22 Oct 2026 (Amendment (iii) §E): "never disclose to the user the models and effort settings". Every route that runs
 * Atomik's thinking (and the Treatment writer) is driven here, quote and run, under the mocked engines (ENGINE_MOCK=1) and the
 * checked-in catalogue snapshot: no body a member is sent holds a thinking model id, a family-and-version name or an effort field.
 * Real temporary databases; nothing is sent anywhere and nothing is billed for real. The pickers are gone (3b-2); the menus' reads
 * (GET /api/atomik, GET /api/workbench/atomik and /development state) are driven here too, and carry no model.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-no-model-disclosure-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
const prior = { catalog: process.env.MODEL_CATALOG, writer: process.env.TREATMENT_WRITER_MODEL };
/** The Treatment writer here: a verified OpenAI id the checked-in catalogue serves (read from it, never written down). */
let WRITER = "";
test.beforeAll(async () => {
  process.env.MODEL_CATALOG = "static";
  const { staticCatalog } = await import("../../lib/catalog");
  WRITER = staticCatalog().find((m) => VERIFIED_TEXT_MODEL_IDS.includes(m.id as never) && m.owner === "openai" && m.type === "language")!.id;
  process.env.TREATMENT_WRITER_MODEL = WRITER;
  await alignLedgerUnit();
});
test.afterAll(() => {
  if (prior.catalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = prior.catalog;
  if (prior.writer === undefined) delete process.env.TREATMENT_WRITER_MODEL; else process.env.TREATMENT_WRITER_MODEL = prior.writer;
});

/* Thinking-model ids, family-and-version names and effort settings in a string: tests/helpers/uiStrings.ts `thinkingModelNames` (#880). */
/** Every key named `effort`, at any depth. */
function effortKeys(value: unknown, at = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => effortKeys(item, `${at}[${i}]`));
  return Object.entries(value).flatMap(([key, item]) => [...(key === "effort" ? [`${at}.effort`] : []), ...effortKeys(item, `${at}.${key}`)]);
}
const policyIds = () => [HIGH, MEDIUM, LOW, WRITER];
const seen: string[] = [];
function expectNothingDisclosed(label: string, body: unknown) {
  seen.push(label);
  const text = JSON.stringify(body);
  expect(thinkingModelNames(text), `${label}: ${text.slice(0, 400)}`).toEqual([]);
  for (const id of policyIds()) expect(text, `${label}: ${id}`).not.toContain(id);
  expect(effortKeys(body), label).toEqual([]);
}

const person = { id: "u_nd", email: "u_nd@example.test", name: "Nadia", role: "admin", owner: true, disabled: false, lastSeen: null, createdAt: 0 } as TenantUser;
function workspace(name: string): TenantWorkspace {
  const id = `ws_nd_${name}_${randomUUID().slice(0, 8)}`;
  return { id, slug: id, name, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: person.id, createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user: person });
}
async function funded(name: string) {
  const ws = workspace(name);
  const { ready } = await import("../../lib/db");
  await inTenant(ws, async () => { await ready(); await fundFixtureWorkspace(); });
  return ws;
}
type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function route(file: string, extra: Record<string, unknown> = {}) {
  const auth = await import("../../lib/auth");
  const next = createRequire(path.resolve("package.json"))("next/server") as Record<string, unknown>;
  return loadRouteModule<{ GET?: Handler; POST?: Handler; PATCH?: Handler; PUT?: Handler }>(file, {
    "@/lib/auth": { ...auth, withTenant: (fn: Handler) => fn, requireUser: async () => ({ user: person }), requireRender: async () => ({ user: person }), requireSession: async () => ({ user: person }) },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
    /* Work handed to after() is not run here: the test runs what it needs itself. */
    "next/server": { ...next, after: () => {} },
    ...extra,
  });
}
const json = (url: string, body: unknown, method = "POST") => new Request(`https://particl.test${url}`, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": `nd-${randomUUID()}` }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });
/* What a page sends: a slot's own model and its effort, both ignored and never echoed. */
const SENT = { model: MEDIUM, effort: "high" };

test("chat: the composer's list, the quote, the new chat, a turn, and the chat read back carry no thinking model or effort", async () => {
  /* The pickers are gone (3b-2): a person sets Thinking, never a model. No file draws a model or effort picker, and the composer, its
     provider, the run dialog and the agent reads that fed them keep no list of thinking models to draw one from. */
  expect(existsSync("components/atomik/ModelPicker.tsx")).toBe(false);
  for (const file of ["components/atomik/AtomikProvider.tsx", "components/atomik/ChatComposer.tsx", "components/workbench/AtomikRunDialog.tsx",
    "components/graphite/business/use-own-agent.ts", "components/workbench/use-production-jobs.ts"]) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/ModelPicker|EffortPicker|setThinkingModel|setReasoningEffort|\bmodels\b/);
  }
  const ws = await funded("chat");
  const index = await route("app/api/atomik/route.ts");
  const turn = await route("app/api/atomik/[id]/route.ts");
  await inTenant(ws, async () => {
    const quoted = await answer(await index.POST!(json("/api/atomik", { quoteOnly: true, text: "Plan two shots at the market.", ...SENT })));
    expect(quoted.status).toBe(200);
    expectNothingDisclosed("POST /api/atomik quote", quoted.body);
    /* The quote's head is the Thinking level it was quoted at, and a planning quote sends nothing else beside its price. */
    expect(Object.keys(quoted.body).sort()).toEqual(["estimateCredits", "thinking"]);
    expect(quoted.body.thinking).toBe("medium");
    const made = await answer(await index.POST!(json("/api/atomik", { projectId: null, ...SENT })));
    const id = String(made.body.id);
    const ctx = { params: Promise.resolve({ id }) };
    const quote = await answer(await turn.POST!(json(`/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots.", ...SENT }), ctx));
    expectNothingDisclosed("POST /api/atomik/[id] quote", quote.body);
    expect(Object.keys(quote.body).sort()).toEqual(["estimateCredits", "thinking"]);
    expect(quote.body.thinking).toBe("medium");
    /* An admin's other level is what the next quote says, still a word and never the slot's model or effort. */
    const { setSetting } = await import("../../lib/settings");
    await setSetting("atomikThinking", "high", person.id);
    const high = await answer(await turn.POST!(json(`/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots.", ...SENT }), ctx));
    expect(high.body.thinking).toBe("high");
    expectNothingDisclosed("POST /api/atomik/[id] quote at High", high.body);
    await setSetting("atomikThinking", "medium", person.id);
    /* The composer's source (GET /api/atomik, read by components/atomik/AtomikProvider.tsx): no menu of thinking models, only whether one is served. */
    const listed = await answer(await index.GET!(new Request("https://particl.test/api/atomik")));
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    expect(listed.body.configured).toBe(true);
    expect(listed.body).not.toHaveProperty("models");
    expectNothingDisclosed("GET /api/atomik", listed.body);
    const ran = await answer(await turn.POST!(json(`/api/atomik/${id}`, { text: "Plan two shots.", ...SENT, maxCredits: quote.body.estimateCredits }), ctx));
    expect(ran.status, JSON.stringify(ran.body).slice(0, 300)).toBe(200);
    expectNothingDisclosed("POST /api/atomik/[id] turn", ran.body);
    expectNothingDisclosed("GET /api/atomik/[id]", (await answer(await turn.GET!(new Request(`https://particl.test/api/atomik/${id}`), ctx))).body);
    expectNothingDisclosed("PATCH /api/atomik/[id]", (await answer(await turn.PATCH!(json(`/api/atomik/${id}`, { title: "Market", ...SENT }, "PATCH"), ctx))).body);
    /* The rows keep what ran, for settlement and the platform admin. */
    const { db } = await import("../../lib/db");
    expect((await db().execute({ sql: "SELECT model FROM atomik_chats WHERE id=?", args: [id] })).rows[0].model).toBe(MEDIUM);
  });
});

test("ideas, shot lists, a Treatment scene and the memory read: quotes and replies carry no thinking model or effort", async () => {
  const ws = await funded("writing");
  const atomikDocs = await import("../../lib/atomikDocs");
  const treatment = { logline: "A courier on the last night train.", setup: {}, scenes: [{ n: 1, title: "Platform", secs: 12, prose: "Rain on the platform." }], updatedAt: 1 };
  const docs = { "@/lib/atomikDocs": { ...atomikDocs, getTreatment: async () => treatment } };
  const cases: [string, string, Record<string, unknown>, Record<string, unknown>?][] = [
    ["app/api/atomik/ideas/draft/route.ts", "/api/atomik/ideas/draft", { brief: "A lighthouse keeper's last night." }],
    ["app/api/atomik/shots/draft/route.ts", "/api/atomik/shots/draft", { projectId: "p1", scene: 1 }, docs],
    ["app/api/atomik/treatment/scene/route.ts", "/api/atomik/treatment/scene", { projectId: "p1", n: 1 }, docs],
    ["app/api/atomik/memory/read/route.ts", "/api/atomik/memory/read", { text: "Our tone is warm and quiet. The brand is teal." }],
  ];
  expect(treatmentWriter()).toMatchObject({ model: WRITER });
  for (const [file, url, body, extra] of cases) {
    const loaded = await route(file, extra);
    await inTenant(ws, async () => {
      const quote = await answer(await loaded.POST!(json(url, { ...body, ...SENT, quoteOnly: true })));
      expect(quote.status, `${url}: ${JSON.stringify(quote.body)}`).toBe(200);
      expectNothingDisclosed(`${url} quote`, quote.body);
      const ran = await answer(await loaded.POST!(json(url, { ...body, ...SENT, maxCredits: quote.body.estimateCredits })));
      expect(ran.status, `${url}: ${JSON.stringify(ran.body)}`).toBe(200);
      expectNothingDisclosed(`${url} run`, ran.body);
    });
  }
});

test("Studio Atomik and development: the menus, the quote, the accepted job and the job read back carry no thinking model or effort", async () => {
  const ws = await funded("studio");
  const { db } = await import("../../lib/db");
  const { seedProject } = await import("../../lib/workbench/studio");
  const server = await import("../../lib/workbench/atomik-server");
  const workbench = await route("app/api/workbench/atomik/route.ts");
  const development = await route("app/api/workbench/development/route.ts");
  await inTenant(ws, async () => {
    await server.atomikReady();
    const project = seedProject();
    project.id = `nd-${randomUUID()}`; project.productionProjectId = `real-${randomUUID()}`;
    project.script = "EXT. DUNES - DAY\nWren follows her reflection.";
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${person.id}:${project.id}`, person.id, project.id, project.name, JSON.stringify(project), Date.now()] });

    /* The pickers' menus: whether Atomik's thinking is served, and no model, name, band or effort (nor a default model). */
    for (const [label, handler, url] of [["GET /api/workbench/atomik", workbench, "/api/workbench/atomik"], ["GET /api/workbench/development", development, "/api/workbench/development"]] as const) {
      const state = await answer(await handler.GET!(new Request(`https://particl.test${url}?${new URLSearchParams({ projectId: project.id })}`)));
      expect(state.status, `${label}: ${JSON.stringify(state.body).slice(0, 300)}`).toBe(200);
      expect(state.body, label).toMatchObject({ configured: true, models: [] });
      expect(state.body, label).not.toHaveProperty("defaultModel");
      expectNothingDisclosed(label, state.body);
    }

    const ask = { projectId: project.id, requestId: `req_${randomUUID()}`, request: "Make a shot proposal for the dunes", depth: "Quick", refs: [], ...SENT };
    const quote = await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, quoteOnly: true })));
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expectNothingDisclosed("POST /api/workbench/atomik quote", quote.body);
    const accepted = await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, maxCredits: quote.body.estimateCredits })));
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    expectNothingDisclosed("POST /api/workbench/atomik", accepted.body);
    const job = accepted.body.job as { id: string };
    /* The mocked engine's reply, written here as a valid proposal. */
    const proposal = { intent: "shots", summary: "Wren at the dunes.", steps: ["Open wide on the dunes."] };
    await server.runAtomikJob(job.id, person.id, { run: async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 210, completion_tokens: 60, cost: 0.003 } }) }) });
    const listed = await answer(await workbench.GET!(new Request(`https://particl.test/api/workbench/atomik?${new URLSearchParams({ projectId: project.id, requestId: ask.requestId })}`)));
    expect((listed.body.jobs as { status: string; plan?: { model?: string } | null }[])[0], JSON.stringify(listed.body)).toMatchObject({ status: "succeeded", plan: { model: "atomik" } });
    expectNothingDisclosed("GET /api/workbench/atomik?requestId", listed.body);

    const develop = { projectId: project.id, requestId: `req_${randomUUID()}`, kind: "screenplay", ...SENT };
    const devQuote = await answer(await development.POST!(json("/api/workbench/development", { ...develop, quoteOnly: true })));
    expect(devQuote.status, JSON.stringify(devQuote.body)).toBe(200);
    expectNothingDisclosed("POST /api/workbench/development quote", devQuote.body);
    const started = await answer(await development.POST!(json("/api/workbench/development", { ...develop, sourceHash: devQuote.body.sourceHash, maxCredits: devQuote.body.estimateCredits })));
    expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
    expectNothingDisclosed("POST /api/workbench/development", started.body);
    const devJob = started.body.job as { id: string };
    const read = await answer(await development.GET!(new Request(`https://particl.test/api/workbench/development?${new URLSearchParams({ projectId: project.id, jobId: devJob.id })}`)));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expectNothingDisclosed("GET /api/workbench/development?jobId", read.body);
    /* The rows keep what ran. */
    expect((await db().execute({ sql: "SELECT model FROM workbench_atomik_jobs WHERE id=?", args: [job.id] })).rows[0].model).toBe(MEDIUM);
  });
});

test("refusals and failures: the 409 when the estimate changed, the 502 unusable answer, and a failed job's error carry no thinking model, even when the provider's message names it", async () => {
  const ws = await funded("errors");
  const paidText = await import("../../lib/paidText");
  const atomik = await import("../../lib/atomik");
  const ideas = await route("app/api/atomik/ideas/draft/route.ts");
  const turn = await route("app/api/atomik/[id]/route.ts");
  /* The writer answers, but not with a logline: refused at zero (502), in words that name no model. */
  const unusable = await route("app/api/atomik/ideas/draft/route.ts", { "@/lib/paidText": { ...paidText, runPaidText: async () => ({ id: "text_x", text: "not a logline", costUsd: 0, engine: "anthropic", credits: 0 }) } });
  await inTenant(ws, async () => {
    const quote = await answer(await ideas.POST!(json("/api/atomik/ideas/draft", { brief: "A lighthouse.", quoteOnly: true })));
    const changed = await answer(await ideas.POST!(json("/api/atomik/ideas/draft", { brief: "A lighthouse.", maxCredits: 0, ...SENT })));
    expect(Number(quote.body.estimateCredits)).toBeGreaterThan(0);
    expect(changed.status).toBe(409);
    expectNothingDisclosed("ideas 409 estimate changed", changed.body);
    const bad = await answer(await unusable.POST!(json("/api/atomik/ideas/draft", { brief: "A lighthouse.", maxCredits: 100 })));
    expect(bad.status).toBe(502);
    expectNothingDisclosed("ideas 502 unusable answer", bad.body);
    const id = await atomik.createChat({ userId: person.id, projectId: null, model: "auto", agentMode: "ask" });
    const turnChanged = await answer(await turn.POST!(json(`/api/atomik/${id}`, { text: "Plan two shots.", maxCredits: 0 }), { params: Promise.resolve({ id }) }));
    expect(turnChanged.status).toBe(409);
    expectNothingDisclosed("chat turn 409 estimate changed", turnChanged.body);
  });

  /* A Studio Atomik job the provider refuses with a message that names the model and its effort. */
  const { db } = await import("../../lib/db");
  const { seedProject } = await import("../../lib/workbench/studio");
  const server = await import("../../lib/workbench/atomik-server");
  const dev = await import("../../lib/workbench/development-server");
  const workbench = await route("app/api/workbench/atomik/route.ts");
  const development = await route("app/api/workbench/development/route.ts");
  const providerSays = JSON.stringify({ provider: "anthropic", error: { type: "invalid_request_error", message: `${MEDIUM} (${DIRECT_MODEL_IDS[MEDIUM]}) does not accept reasoning_effort: high` } });
  await inTenant(ws, async () => {
    await server.atomikReady();
    const project = seedProject();
    project.id = `nd-${randomUUID()}`; project.productionProjectId = `real-${randomUUID()}`;
    project.script = "EXT. DUNES - DAY\nWren follows her reflection.";
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${person.id}:${project.id}`, person.id, project.id, project.name, JSON.stringify(project), Date.now()] });
    const ask = { projectId: project.id, requestId: `req_${randomUUID()}`, request: "Make a shot proposal for the dunes", depth: "Quick", refs: [] };
    const quote = await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, quoteOnly: true })));
    const job = (await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, maxCredits: quote.body.estimateCredits })))).body.job as { id: string };
    await server.runAtomikJob(job.id, person.id, { run: async () => ({ ok: false, status: 400, text: providerSays }) });
    const listed = await answer(await workbench.GET!(new Request(`https://particl.test/api/workbench/atomik?${new URLSearchParams({ projectId: project.id, requestId: ask.requestId })}`)));
    const failed = (listed.body.jobs as { status: string; error: string }[])[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Nothing billed.");
    expectNothingDisclosed("a failed Studio Atomik job", listed.body);

    /* A development step whose provider call fails with the same words. */
    const develop = { projectId: project.id, requestId: `req_${randomUUID()}`, kind: "screenplay" as const, model: "auto", effort: "auto" };
    const devQuote = await dev.quoteDevelopmentJob(develop, person.id);
    const { job: devJob } = await dev.prepareDevelopmentJob({ ...develop, sourceHash: devQuote.sourceHash, maxCredits: devQuote.estimateCredits }, person.id);
    await dev.runDevelopmentStep(devJob.id, person.id, { call: async () => { throw Object.assign(new Error(providerSays), { statusCode: 400 }); } });
    const read = await answer(await development.GET!(new Request(`https://particl.test/api/workbench/development?${new URLSearchParams({ projectId: project.id, jobId: devJob.id })}`)));
    expect((read.body.job as { status: string }).status).toBe("failed");
    expectNothingDisclosed("a failed development job", read.body);
    /* The development state's job list, on its own (its model menu is the picker's until the Thinking control). */
    const state = await answer(await development.GET!(new Request(`https://particl.test/api/workbench/development?${new URLSearchParams({ projectId: project.id })}`)));
    expect((state.body.jobs as unknown[]).length).toBeGreaterThan(0);
    expectNothingDisclosed("GET /api/workbench/development jobs", state.body.jobs);
  });
});

test("the chat list, Verify scorecards, statements, the usage ledger and the export carry no thinking model or effort", async () => {
  const ws = await funded("records");
  const index = await route("app/api/atomik/route.ts");
  const turn = await route("app/api/atomik/[id]/route.ts");
  const { db } = await import("../../lib/db");
  await inTenant(ws, async () => {
    /* A turn that ran, so the chat, the meter and the ledgers hold a line of Atomik's thinking. */
    const made = await answer(await index.POST!(json("/api/atomik", { projectId: null, ...SENT })));
    const id = String(made.body.id), ctx = { params: Promise.resolve({ id }) };
    const quote = await answer(await turn.POST!(json(`/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots." }), ctx));
    expect((await turn.POST!(json(`/api/atomik/${id}`, { text: "Plan two shots.", maxCredits: quote.body.estimateCredits }), ctx)).status).toBe(200);
    const listed = await answer(await index.GET!(new Request("https://particl.test/api/atomik")));
    expect((listed.body.chats as unknown[]).length).toBeGreaterThan(0);
    expectNothingDisclosed("GET /api/atomik chats", listed.body.chats);

    /* A Verify scorecard stored with its judge's model: the list and a check already stored never send it. */
    const { seedProject } = await import("../../lib/workbench/studio");
    const server = await import("../../lib/workbench/atomik-server");
    const verify = await import("../../lib/workbench/verify-server");
    const development = await route("app/api/workbench/development/route.ts");
    await server.atomikReady(); await verify.verifyReady();
    const project = seedProject();
    project.id = `nd-${randomUUID()}`; project.productionProjectId = `real-${randomUUID()}`;
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${person.id}:${project.id}`, person.id, project.id, project.name, JSON.stringify(project), Date.now()] });
    const key = { takeId: "take_nd", masterSet: "[]", rubric: 1, framesKey: "" };
    const hashes = verify.verifyKeyHashes(key);
    await db().execute({ sql: `INSERT INTO take_verifications(id,production_id,project_id,verify_node_id,take_id,master_set_hash,master_set,masters,rubric,frames_hash,frames_key,frames,checks,verdict,judge_model,meter_event_id,credits,funded_by_platform,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [`tv_${randomUUID()}`, project.productionProjectId, project.id, "check", key.takeId, hashes.masterSetHash, key.masterSet, "[]", key.rubric, hashes.framesHash, key.framesKey, "[]", "[]", "pass", LOW, "m_nd", 2, 1, person.id, Date.now()] });
    const list = await answer(await development.GET!(new Request(`https://particl.test/api/workbench/development?${new URLSearchParams({ projectId: project.id, verifications: "1" })}`)));
    expect((list.body.verifications as unknown[]).length).toBe(1);
    expectNothingDisclosed("GET /api/workbench/development?verifications=1", list.body);
    /* The stored check a Verify quote answers with (development-server › storedVerificationFor reads it through the same mapper). */
    expectNothingDisclosed("a stored check", await verify.storedVerification(key));

    /* Statements, the usage ledger and the usage page: a line of Atomik's thinking says "Thinking". */
    const { statementFor } = await import("../../lib/statements");
    const { usageLedgerPage } = await import("../../lib/usageLedger");
    const { creditUsage } = await import("../../lib/creditUsage");
    const month = new Date().toISOString().slice(0, 7);
    const statement = await statementFor(month, null);
    expect(JSON.stringify(statement)).toContain("Thinking");
    expectNothingDisclosed("a statement", statement);
    const ledger = await usageLedgerPage({ source: "ledger", month: null, range: null, cursor: null, limit: 50, id: null, csv: false }, { id: person.id, admin: true });
    expect(JSON.stringify(ledger.rows)).toContain("Atomik · Thinking");
    expectNothingDisclosed("the usage ledger", ledger);
    /* A second thinking model ran too: the usage page still shows one "Thinking" row, served by "atomik". */
    const { meter } = await import("../../lib/meter");
    await meter({ id: `text_nd_${randomUUID()}`, kind: "text", engine: "anthropic", model: LOW, status: "succeeded", engineCostUsd: 0.001, projectId: null, createdBy: person.id });
    const usage = await creditUsage({ id: person.id, admin: true });
    const thinking = (usage.byModel as { kind: string; provider: string; label: string; model: string }[]).filter((row) => row.kind === "text");
    expect(thinking).toEqual([expect.objectContaining({ model: "atomik", label: "Thinking", provider: "atomik" })]);
    expectNothingDisclosed("the usage page", usage);

    /* The export: a Studio Atomik job without its model or effort, in its request or its plan. */
    const workbench = await route("app/api/workbench/atomik/route.ts");
    const ask = { projectId: project.id, requestId: `req_${randomUUID()}`, request: "Make a shot proposal", depth: "Quick", refs: [], ...SENT };
    const wq = await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, quoteOnly: true })));
    const accepted = (await answer(await workbench.POST!(json("/api/workbench/atomik", { ...ask, maxCredits: wq.body.estimateCredits })))).body.job as { id: string };
    const proposal = { intent: "shots", summary: "Wren at the dunes.", steps: ["Open wide."] };
    await server.runAtomikJob(accepted.id, person.id, { run: async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.001 } }) }) });
    /* Two more lines of Atomik's thinking: one billed past its estimate (an overrun, the platform's dollars), one failed with a provider's own words that name the model. */
    const { silentOutcome } = await import("../../lib/providerOutcome");
    await meter({ id: `text_over_${randomUUID()}`, kind: "text", engine: "anthropic", model: MEDIUM, status: "succeeded", engineCostUsd: 0.002, overrunUsd: 0.002, projectId: null, createdBy: person.id });
    await meter({ id: `text_fail_${randomUUID()}`, kind: "text", engine: "anthropic", model: MEDIUM, status: "failed", engineCostUsd: 0, projectId: null, createdBy: person.id,
      providerOutcome: silentOutcome("anthropic", "run", "http_400", `${MEDIUM} rejected reasoning_effort high`) });
    const { workspaceExport } = await import("../../lib/workspaceExport");
    const exported = await workspaceExport(person.id, person.email) as unknown as { contents?: Record<string, unknown[]> } & Record<string, unknown>;
    const jobs = (exported.contents ?? exported).workbench_atomik_jobs as Record<string, unknown>[];
    expect(jobs.length).toBeGreaterThan(0);
    const meterRows = (exported.contents ?? exported).meter_events as Record<string, unknown>[];
    expect(meterRows.some((row) => row.kind === "text" && row.model === "atomik" && row.engine === "atomik")).toBe(true);
    /* A credit workspace's export carries no vendor dollars: neither what a line cost the platform nor what it cost past its bill. */
    for (const row of meterRows) { expect(row, String(row.id)).not.toHaveProperty("engine_cost_usd"); expect(row, String(row.id)).not.toHaveProperty("overrun_usd"); }
    const failedOutcome = meterRows.find((row) => String(row.id).startsWith("text_fail_"))?.provider_outcome;
    expect(JSON.parse(String(failedOutcome))).toMatchObject({ provider: "atomik", message: null });
    /* The whole export, every table: no thinking model's name, id or effort anywhere in it. */
    expectNothingDisclosed("the whole export", exported);
  });
});

test("the settings read and an admin's Thinking save carry the level only: no thinking model, version or effort", async () => {
  const ws = await funded("settings");
  const settings = await route("app/api/settings/route.ts", { "@/lib/auth": { ...(await import("../../lib/auth")), withTenant: (fn: Handler) => fn,
    requireUser: async () => ({ user: person }), requireAdmin: async () => ({ user: person }) } });
  await inTenant(ws, async () => {
    for (const level of ["high", "low", "medium"]) {
      const saved = await answer(await settings.PATCH!(json("/api/settings", { atomikThinking: level }, "PATCH")));
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expectNothingDisclosed(`PATCH /api/settings ${level}`, saved.body);
      const read = await answer(await settings.GET!(new Request("https://particl.test/api/settings")));
      expect(read.status).toBe(200);
      expect((read.body.settings as Record<string, string>).atomikThinking).toBe(level);
      /* The whole read a member is sent, the platform's defaults included: the level is there, no thinking model is. */
      expectNothingDisclosed(`GET /api/settings at ${level}`, read.body);
    }
  });
});

test("ideas and the Treatment as older rows stored them (with the model and effort they were written at): the lists, an edit, a kept draft and the export carry neither, at each Thinking level", async () => {
  const ws = await funded("documents");
  const ideas = await route("app/api/atomik/ideas/route.ts");
  const idea = await route("app/api/atomik/ideas/[id]/route.ts");
  const treatment = await route("app/api/atomik/treatment/route.ts");
  const { db } = await import("../../lib/db");
  const { createIdea } = await import("../../lib/atomikDocs");
  const { setSetting } = await import("../../lib/settings");
  const { workspaceExport } = await import("../../lib/workspaceExport");
  await inTenant(ws, async () => {
    for (const [level, id] of [["high", HIGH], ["medium", MEDIUM], ["low", LOW]] as const) {
      await setSetting("atomikThinking", level, person.id);
      /* An idea written up at this level before 23 Oct 2026: the row holds the slot's model and its effort. */
      const stored = await createIdea({ logline: `A lighthouse keeper at ${level}.`, tone: [], refs: [], model: id, effort: "high", createdBy: person.id });
      expect((await db().execute({ sql: "SELECT model, effort FROM ideas WHERE id=?", args: [stored.id] })).rows[0]).toMatchObject({ model: id, effort: "high" });
      const listed = await answer(await ideas.GET!(new Request("https://particl.test/api/atomik/ideas")));
      expect(listed.status).toBe(200);
      expect((listed.body.ideas as { id: string }[]).map((i) => i.id)).toContain(stored.id);
      expectNothingDisclosed(`GET /api/atomik/ideas at ${level}`, listed.body);
      const ctx = { params: Promise.resolve({ id: stored.id }) };
      const pinned = await answer(await idea.PATCH!(json(`/api/atomik/ideas/${stored.id}`, { pin: true }, "PATCH"), ctx));
      expect(pinned.status).toBe(200);
      expectNothingDisclosed(`PATCH /api/atomik/ideas/[id] at ${level}`, pinned.body);
      /* An older page that still sends the slot's model and an effort with a new card: neither comes back. */
      const made = await answer(await ideas.POST!(json("/api/atomik/ideas", { logline: `A ferry at ${level}.`, ...SENT, model: id })));
      expect(made.status).toBe(200);
      expectNothingDisclosed(`POST /api/atomik/ideas at ${level}`, made.body);

      /* A treatment whose scenes were written at this level (and by the Treatment writer), and a draft kept from it. */
      const projectId = `nd-treatment-${level}-${randomUUID().slice(0, 8)}`;
      await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [projectId, `Treatment ${level}`] });
      const scenes = [
        { n: 1, title: "Platform", secs: 12, prose: "Rain on the platform.", by: id, effort: "high", at: 1 },
        { n: 2, title: "Carriage", secs: 9, prose: "She counts the stops.", by: WRITER, effort: "xhigh", at: 2 },
        { n: 3, title: "Terminus", secs: 7, prose: "The doors open.", by: "you", at: 3 },
      ];
      await db().execute({ sql: "INSERT INTO treatments(id,project_id,draft,title,logline,setup,scenes,notes,updated_by,created_at,updated_at) VALUES(?,?,2,?,?,?,?,?,?,1,5)",
        args: [`trt_${randomUUID()}`, projectId, "Night train", "A courier on the last night train.", "{}", JSON.stringify(scenes), "[]", person.name] });
      await db().execute({ sql: `INSERT INTO treatment_versions(id,project_id,version,title,logline,setup,scenes,notes,"by",created_at) VALUES(?,?,1,?,?,?,?,?,?,4)`,
        args: [`tv_${randomUUID()}`, projectId, "Night train", "A courier.", "{}", JSON.stringify(scenes), "[]", person.name] });
      const read = await answer(await treatment.GET!(new Request(`https://particl.test/api/atomik/treatment?${new URLSearchParams({ projectId, version: "1" })}`)));
      expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
      /* Who wrote each scene is still said: Atomik, or the person. */
      for (const copy of [read.body.treatment, read.body.snapshot] as { scenes: { by?: string }[] }[]) expect(copy.scenes.map((s) => s.by)).toEqual(["atomik", "atomik", "you"]);
      expectNothingDisclosed(`GET /api/atomik/treatment at ${level}`, read.body);
      /* A save from a page that still holds the stored scenes: the answer, and the row it writes, carry neither. */
      const saved = await answer(await treatment.PUT!(json("/api/atomik/treatment", { projectId, title: "Night train", logline: "A courier.", setup: {}, scenes, notes: [], expectedUpdatedAt: 5, bump: true }, "PUT")));
      expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
      expectNothingDisclosed(`PUT /api/atomik/treatment at ${level}`, saved.body);
      const row = String((await db().execute({ sql: "SELECT scenes FROM treatments WHERE project_id=?", args: [projectId] })).rows[0].scenes);
      expectNothingDisclosed(`the saved treatment row at ${level}`, JSON.parse(row));
    }
    /* The export, every table: the older idea rows and treatment rows hold the slots' models; what is sent holds none. */
    expectNothingDisclosed("the export of ideas and treatments", await workspaceExport(person.id, person.email));
  });
});

test("a saved project's Atomik plans, as pages saved them from job replies that named the model and effort: the project read and the export carry neither, at each Thinking level", async () => {
  const ws = await funded("plans");
  const projects = await route("app/api/workbench/projects/route.ts");
  const { db } = await import("../../lib/db");
  const { seedProject } = await import("../../lib/workbench/studio");
  const { projectSchema } = await import("../../lib/workbench/studio-schema");
  const { workspaceExport } = await import("../../lib/workspaceExport");
  const server = await import("../../lib/workbench/atomik-server");
  await inTenant(ws, async () => {
    await server.atomikReady();
    for (const [level, id] of [["high", HIGH], ["medium", MEDIUM], ["low", LOW]] as const) {
      const project = seedProject();
      project.id = `nd-plans-${level}-${randomUUID().slice(0, 8)}`; project.productionProjectId = `real-${randomUUID()}`;
      project.plans = [{ id: `plan_${level}`, request: "Make a shot proposal", model: id, depth: "Quick", effort: "high", intent: "shots", summary: "Wren at the dunes.", steps: ["Open wide."], applied: true, refs: [] }];
      /* The body a page saved before 23 Oct 2026 is a valid project: the plan's model and effort are what it kept. */
      expect(projectSchema.safeParse(project).success).toBe(true);
      await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${person.id}:${project.id}`, person.id, project.id, project.name, JSON.stringify(project), Date.now()] });
      const read = await answer(await projects.GET!(new Request(`https://particl.test/api/workbench/projects?${new URLSearchParams({ id: project.id })}`)));
      expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
      const plans = (read.body.project as { plans: { id: string; model: string; applied: boolean }[] }).plans;
      /* The plan is still there, applied, and says it is Atomik's. */
      expect(plans).toEqual([expect.objectContaining({ id: `plan_${level}`, model: "atomik", applied: true })]);
      expectNothingDisclosed(`GET /api/workbench/projects?id at ${level}`, read.body);
    }
    expectNothingDisclosed("the export of saved projects", await workspaceExport(person.id, person.email));
  });
});

test("an effort a model does not offer is refused in words that name no model: each Thinking slot's and the Treatment writer's", async () => {
  const ws = await funded("effort");
  const { staticCatalog } = await import("../../lib/catalog");
  const { quotePaidText, paidTextFailure } = await import("../../lib/paidText");
  await inTenant(ws, async () => {
    for (const [label, id] of [["High", HIGH], ["Medium", MEDIUM], ["Low", LOW], ["the Treatment writer", WRITER]] as const) {
      /* The catalogue's own name for the model is one the matcher catches: had the refusal named it, this would fail. */
      expect(thinkingModelNames(staticCatalog().find((m) => m.id === id)!.name), label).not.toEqual([]);
      const refused = await quotePaidText({ model: id, effort: "not-an-effort", maxTokens: 400, messages: [{ role: "user", content: "Plan two shots." }] }).then(() => null, (error: unknown) => error);
      expect(refused, label).toBeInstanceOf(Error);
      /* paidTextFailure is the one way every Atomik and Treatment route answers such a refusal. */
      const said = await answer(paidTextFailure(refused));
      expect(said.status, label).toBe(400);
      expect(said.body.error, label).toBe("That effort setting is not available.");
      expectNothingDisclosed(`an unoffered effort at ${label}`, said.body);
    }
  });
});

test("the person's own read and the session every page renders with carry the engines a composer opens on and their rates, never a text model or its rate, at each Thinking level", async () => {
  const ws = await funded("me");
  const me = await route("app/api/me/route.ts");
  const { setSetting } = await import("../../lib/settings");
  const { effectiveModels, memberModels } = await import("../../lib/defaultModels");
  const { buildRateTable, memberRateTable } = await import("../../lib/rateTable.server");
  await inTenant(ws, async () => {
    /* What is held back: the platform's text jobs, and the writer's rates, are keyed by models the matcher catches. */
    expect(thinkingModelNames(JSON.stringify((await effectiveModels()).text))).not.toEqual([]);
    expect(thinkingModelNames(JSON.stringify(buildRateTable("cr").text))).not.toEqual([]);
    for (const level of ["high", "medium", "low"]) {
      await setSetting("atomikThinking", level, person.id);
      const read = await answer(await me.GET!(new Request("https://particl.test/api/me")));
      expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
      expect(read.body.models).toEqual(await memberModels());
      expect(Object.keys(read.body.models as object).sort()).toEqual(["image", "video"]);
      /* The engines' rates are all there, as the composer's estimates read them; the writer's are not. */
      expect(read.body.rates).toEqual({ ...buildRateTable("cr"), text: {} });
      expectNothingDisclosed(`GET /api/me at ${level}`, read.body);
    }
  });
  for (const unit of ["cr", "usd"] as const) expectNothingDisclosed(`the rate table a browser is handed (${unit})`, memberRateTable(unit));
  /* The session the app's pages and the shell are rendered with (a visitor's too) is built from the same reads (a server render, not driven here). */
  for (const file of ["app/(app)/layout.tsx", "lib/shell/bootstrap.server.ts"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).toContain("memberModels()");
    expect(source, file).toContain("memberRateTable(");
    expect(source, file).not.toMatch(/effectiveModels|buildRateTable/);
  }
});

test("the matcher finds every slot's id, the writer's and an effort, and lets engines through", () => {
  for (const id of [HIGH, MEDIUM, LOW, WRITER, DIRECT_MODEL_IDS[MEDIUM]]) expect(thinkingModelNames(JSON.stringify({ model: id })), id).not.toEqual([]);
  expect(thinkingModelNames("reasoning_effort, effort: high")).toHaveLength(2);
  /* The engines a Director picks are named where they are picked: every engine label, as the menus show it, passes. */
  expect(thinkingModelNames(`${MODELS.filter((m) => m.kind === "video" || m.kind === "image").map((m) => m.label).join(" · ")} · up to 43 cr`)).toEqual([]);
  expect(effortKeys({ a: [{ effort: "high" }] })).toEqual(["$.a[0].effort"]);
});
