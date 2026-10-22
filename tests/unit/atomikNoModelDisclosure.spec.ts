import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { loadRouteModule } from "../helpers/vendorCostScan";
import { ATOMIK_THINKING, treatmentWriter } from "../../lib/atomikModelPolicy";

/*
 * The owner, 22 Oct 2026 (Amendment (iii) §E): "never disclose to the user the models and effort settings". Every route that runs
 * Atomik's thinking (and the Treatment writer) is driven here, quote and run, under the mocked engines (ENGINE_MOCK=1) and the
 * checked-in catalogue snapshot: no body a member is sent holds a thinking model id, a family-and-version name or an effort field.
 * Real temporary databases; nothing is sent anywhere and nothing is billed for real. The pickers' menus (GET /api/atomik,
 * GET /api/workbench/atomik and /development state) stay until the Thinking control replaces them, and are not driven here.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-no-model-disclosure-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
const prior = { catalog: process.env.MODEL_CATALOG, writer: process.env.TREATMENT_WRITER_MODEL };
test.beforeAll(async () => {
  process.env.MODEL_CATALOG = "static";
  process.env.TREATMENT_WRITER_MODEL = "gpt-5.6-sol";
  await alignLedgerUnit();
});
test.afterAll(() => {
  if (prior.catalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = prior.catalog;
  if (prior.writer === undefined) delete process.env.TREATMENT_WRITER_MODEL; else process.env.TREATMENT_WRITER_MODEL = prior.writer;
});

/**
 * Thinking-model ids, family-and-version names and effort settings in a string. The same patterns as tests/helpers/uiStrings.ts
 * `thinkingModelNames` on the copy-table branch (#880), which is not on this branch yet: swap this for the import when it lands.
 */
const HYPHEN = "[-‐‑–]";
const PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bclaude${HYPHEN}(?:fable|opus|sonnet|haiku|instant|mythos|[0-9])[a-z0-9.\\-]*`, "gi"),
  /\b(?:Claude\s+)?(?:Fable|Opus|Sonnet|Haiku|Mythos)\s+\d+(?:\.\d+)?(?![\d.])/gi,
  new RegExp(`\\bgpt${HYPHEN}?\\d+(?:\\.\\d+)?[a-z]*(?:${HYPHEN}[a-z0-9]+)*`, "gi"),
  /\bGPT\s+\d+(?:\.\d+)?(?![\d.])/g,
  new RegExp(`\\bgrok${HYPHEN}\\d[a-z0-9.\\-]*`, "gi"),
  new RegExp(`\\bgemini${HYPHEN}\\d[a-z0-9.\\-]*`, "gi"),
  /\breasoning[_ -]?effort\b/gi,
  /\beffort\s*[:=·]?\s*(?:low|medium|high|xhigh|max)\b/gi,
];
const isImageEngine = (text: string, end: number) => /^[\w.\s\-‐‑–]{0,24}?\bimag(?:e|ine)\b/i.test(text.slice(end, end + 32));
function thinkingModelNames(text: string): string[] {
  return PATTERNS.flatMap((re) => [...text.matchAll(re)].filter((m) => !isImageEngine(text, (m.index ?? 0) + m[0].length) && !/image/i.test(m[0])).map((m) => m[0]));
}
/** Every key named `effort`, at any depth. */
function effortKeys(value: unknown, at = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => effortKeys(item, `${at}[${i}]`));
  return Object.entries(value).flatMap(([key, item]) => [...(key === "effort" ? [`${at}.effort`] : []), ...effortKeys(item, `${at}.${key}`)]);
}
const POLICY_IDS = [...Object.values(ATOMIK_THINKING).map((t) => t.model), "openai/gpt-5.6-sol"];
const seen: string[] = [];
function expectNothingDisclosed(label: string, body: unknown) {
  seen.push(label);
  const text = JSON.stringify(body);
  expect(thinkingModelNames(text), `${label}: ${text.slice(0, 400)}`).toEqual([]);
  for (const id of POLICY_IDS) expect(text, `${label}: ${id}`).not.toContain(id);
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
  return loadRouteModule<{ GET?: Handler; POST?: Handler; PATCH?: Handler }>(file, {
    "@/lib/auth": { ...auth, withTenant: (fn: Handler) => fn, requireUser: async () => ({ user: person }), requireRender: async () => ({ user: person }), requireSession: async () => ({ user: person }) },
    "@/lib/requestOrigin": { crossOriginProblem: () => null },
    /* Work handed to after() is not run here: the test runs what it needs itself. */
    "next/server": { ...next, after: () => {} },
    ...extra,
  });
}
const json = (url: string, body: unknown, method = "POST") => new Request(`https://particl.test${url}`, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": `nd-${randomUUID()}` }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });
const SENT = { model: "anthropic/claude-opus-5.5", effort: "high" };

test("chat: the quote, the new chat, a turn, and the chat read back carry no thinking model or effort", async () => {
  const ws = await funded("chat");
  const index = await route("app/api/atomik/route.ts");
  const turn = await route("app/api/atomik/[id]/route.ts");
  await inTenant(ws, async () => {
    const quoted = await answer(await index.POST!(json("/api/atomik", { quoteOnly: true, text: "Plan two shots at the market.", ...SENT })));
    expect(quoted.status).toBe(200);
    expectNothingDisclosed("POST /api/atomik quote", quoted.body);
    const made = await answer(await index.POST!(json("/api/atomik", { projectId: null, ...SENT })));
    const id = String(made.body.id);
    const ctx = { params: Promise.resolve({ id }) };
    const quote = await answer(await turn.POST!(json(`/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots.", ...SENT }), ctx));
    expectNothingDisclosed("POST /api/atomik/[id] quote", quote.body);
    const ran = await answer(await turn.POST!(json(`/api/atomik/${id}`, { text: "Plan two shots.", ...SENT, maxCredits: quote.body.estimateCredits }), ctx));
    expect(ran.status, JSON.stringify(ran.body).slice(0, 300)).toBe(200);
    expectNothingDisclosed("POST /api/atomik/[id] turn", ran.body);
    expectNothingDisclosed("GET /api/atomik/[id]", (await answer(await turn.GET!(new Request(`https://particl.test/api/atomik/${id}`), ctx))).body);
    expectNothingDisclosed("PATCH /api/atomik/[id]", (await answer(await turn.PATCH!(json(`/api/atomik/${id}`, { title: "Market", ...SENT }, "PATCH"), ctx))).body);
    /* The rows keep what ran, for settlement and the platform admin. */
    const { db } = await import("../../lib/db");
    expect((await db().execute({ sql: "SELECT model FROM atomik_chats WHERE id=?", args: [id] })).rows[0].model).toBe(ATOMIK_THINKING.medium.model);
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
  expect(treatmentWriter()).toMatchObject({ model: "openai/gpt-5.6-sol" });
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

test("Studio Atomik and development: the quote, the accepted job and the job read back carry no thinking model or effort", async () => {
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
    expect((await db().execute({ sql: "SELECT model FROM workbench_atomik_jobs WHERE id=?", args: [job.id] })).rows[0].model).toBe(ATOMIK_THINKING.medium.model);
  });
});

test("the matcher finds what it must and lets engines through", () => {
  expect(thinkingModelNames("Claude Opus 5.5 · High · up to 4 cr")).toEqual(["Claude Opus 5.5"]);
  expect(thinkingModelNames('{"model":"anthropic/claude-sonnet-5.5","x":"openai/gpt-5.6-sol"}')).toEqual(["claude-sonnet-5.5", "gpt-5.6-sol"]);
  expect(thinkingModelNames("reasoning_effort, effort: high")).toHaveLength(2);
  expect(thinkingModelNames("Seedance 2.5 · GPT Image 2 · grok-imagine-video · up to 43 cr")).toEqual([]);
  expect(effortKeys({ a: [{ effort: "high" }] })).toEqual(["$.a[0].effort"]);
});
