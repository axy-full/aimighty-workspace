import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/* The money a route hands the browser: in the unit the workspace pays in,
   and every figure the vendor has charged, hidden takes included. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-money-routes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
let priorCreditValue: string | undefined;
test.beforeEach(() => { priorCreditValue = process.env.CREDIT_USD; process.env.CREDIT_USD = "0.10"; });
test.afterEach(() => { if (priorCreditValue === undefined) delete process.env.CREDIT_USD; else process.env.CREDIT_USD = priorCreditValue; });
process.env.ENGINE_MOCK = "1";
/* Before any fixture row: a fresh platform database counts in today's price (lib/ledgerUnit.ts). */
test.beforeAll(async () => { await alignLedgerUnit(); });

function workspace(id: string, credits: boolean): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: credits, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

/** The route file, compiled as it ships, with its imports answered by `dependencies`. */
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith("@/")) throw new Error(`Unstubbed import ${name} in ${file}`);
      return require(name);
    },
    mod, mod.exports,
  );
  return mod.exports as T;
}
type Handler = (req: Request) => Promise<Response>;
/** NextResponse.json is Response.json with Next's extras, none of which these routes use. */
const nextServer = { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };

async function auth(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const user = { id: "owner", role: "admin", name: "Owner", email: "owner@example.invalid" };
  return {
    requireUser: async () => ({ user }),
    requireRender: async () => ({ user }),
    withTenant: (fn: Handler) => (req: Request) => runInTenant(ws, () => fn(req), { user } as never),
  };
}

test("Usage and its summary keep hidden takes and chats as spent, and a reading counts text down", async () => {
  const ws = workspace(`money_routes_usage_${path.basename(dir)}`, false);
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { recordCheck } = await import("../../lib/reconcile");
  const modules = {
    "next/server": nextServer,
    "@/lib/db": await import("../../lib/db"),
    "@/lib/jobs": { syncActive: async () => {} },
    "@/lib/models": await import("../../lib/models"),
    "@/lib/enhance": { hasFreeTier: () => false, gatewayCredits: async () => null },
    "@/lib/providers": await import("../../lib/providers"),
    "@/lib/elevenlabs": { elevenConfigured: () => false, subscription: async () => null, FALLBACK_USD_PER_CREDIT: 0.0001 },
    "@/lib/auth": await auth(ws),
    "@/lib/reconcile": await import("../../lib/reconcile"),
    "@/lib/storageCost": { storageLedger: async () => null },
    "@/lib/creditReceipts": await import("../../lib/creditReceipts"),
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/creditUsage": await import("../../lib/creditUsage"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/creditTerms": await import("../../lib/creditTerms"),
    "@/lib/memo": { memoGet: () => null, memoPut: () => {} },
    "@/lib/usageLedger": await import("../../lib/usageLedger"),
    "@/lib/usageParams": await import("../../lib/usageParams"),
  };
  const usage = load<{ GET: Handler }>("app/api/usage/route.ts", modules).GET;
  const summary = load<{ GET: Handler }>("app/api/usage/summary/route.ts", modules).GET;
  const reading = Date.now() - 60_000;
  await runInTenant(ws, async () => {
    await ready();
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd,refine_model,refine_cost_usd,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    await db().batch([
      { sql: take, args: ["money-g1", "dreamina-seedance-2-5-260628", "one", JSON.stringify({ resolution: "720p", ratio: "16:9", duration: 4, steps: 12, paidClaim: { token: "private-test-claim" }, credentialFingerprint: "private-test-fingerprint", providerPoll: { token: "private-test-poll" } }), "succeeded", reading - 1_000, reading - 1_000, "video", "byteplus", 1, null, null, 0] },
      { sql: take, args: ["money-g2", "dreamina-seedance-2-5-260628", "two", "{}", "succeeded", reading - 1_000, reading - 1_000, "video", "byteplus", 0.5, null, null, 1] },
      { sql: take, args: ["money-g3", "dreamina-seedance-2-5-260628", "three", "{}", "queued", reading + 1_000, reading + 1_000, "video", "byteplus", null, "anthropic/claude-test", 0.03, 1] },
      { sql: `INSERT INTO atomik_chats(id,created_at,updated_at,deleted,text_cost_usd) VALUES('money-c1',?,?,1,0.2)`, args: [reading, reading] },
      { sql: `INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at) VALUES('money-m1','money-c1','assistant',0.2,?)`, args: [reading + 1_000] },
    ]);
    const { platformReady, platformDb } = await import("../../lib/platform");
    await platformReady();
    for (const [id, kind, engine, cost, credits] of [["money-g1", "video", "byteplus", 1, 15], ["money-g2", "video", "byteplus", .5, 8], ["money-g3", "text", "vercel", .03, 1], ["money-m1", "text", "vercel", .2, 3]] as const)
      await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES(?,?,?,?,'fixture','succeeded',?,?,1,?,?)", args: [id, ws.id, kind, engine, cost, credits, reading, reading] });
    await recordCheck({ provider: "vercel", balanceUsd: 10, spendUsd: 2, balanceCredits: null, spendCredits: null, note: "", checkedAt: reading, userId: "owner" });
  });

  const body = await (await usage(new Request("http://localhost/api/usage"))).json();
  expect(body.recent.find((row: { id: string }) => row.id === "money-g1").params).toEqual({ resolution: "720p", ratio: "16:9", duration: 4, steps: 12 });
  expect(JSON.stringify(body)).not.toContain("private-test-");
  expect(body.unit).toBe("credits");
  expect(body.credits.used).toBe(27);
  expect(body.vendors.every((vendor: Record<string, unknown>) => !("remaining" in vendor) && !("anchor" in vendor))).toBe(true);
  const brief = await (await summary(new Request("http://localhost/api/usage/summary"))).json();
  expect(brief.spentCredits).toBe(27);
  expect(brief.promptSpendCredits).toBe(4);
  expect(brief).not.toHaveProperty("spentUsd");
  expect(brief.pending).toBe(0);
});

async function writerRoutes(ws: TenantWorkspace, text: string) {
  const treatment = { logline: "A courier on the last night train", setup: {}, scenes: [{ n: 1, title: "Platform", secs: 12, prose: "Rain on the platform." }], updatedAt: 1 };
  const atomikDocs = await import("../../lib/atomikDocs");
  const paid = {
    runPaidText: async () => ({ id: "text_1", text, costUsd: 0.4, credits: 6 }),
    quotePaidText: async () => { throw new Error("not a quote"); },
    paidTextQuoteResponse: () => { throw new Error("not a quote"); },
    requestMaxCredits: () => undefined,
    paidTextQuoteScopeFailure: () => null,
    paidTextFailure: (error: unknown) => { throw error; },
  };
  const modules = {
    "@/lib/vendorKeys": { vendorKey: () => "key" },
    "next/server": nextServer,
    "@/lib/auth": await auth(ws),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/atomikDocs": { ...atomikDocs, getTreatment: async () => treatment },
    "@/lib/cast": { listCast: async () => [] },
    "@/lib/atomik": { requestEffort: () => undefined, resolveModel: async () => "test/text" },
    "@/lib/gateway": { gatewayReachable: () => true },
    "@/lib/studio": await import("../../lib/studio"),
    "@/lib/shotBuilder": await import("../../lib/shotBuilder"),
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/paidText": paid,
    "@/lib/generationRequests": { withGenerationRequest: (_req: Request, _user: string, run: () => Promise<Response>) => run() },
  };
  return {
    shots: load<{ POST: Handler }>("app/api/atomik/shots/draft/route.ts", modules).POST,
    scene: load<{ POST: Handler }>("app/api/atomik/treatment/scene/route.ts", modules).POST,
  };
}
const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const SHOTS = JSON.stringify({ shots: [
  { title: "Rain", description: "Rain on the platform.", planned: 6, setup: {}, cast: [], engine: "seedance", why: "the rule" },
  { title: "Door", description: "The train door opens.", planned: 3, setup: {}, cast: [], engine: "kling", why: "physics" },
] });

test("drafted shots and a rewritten scene carry credits to a credit workspace and never the vendor's dollars", async () => {
  const { shots } = await writerRoutes(workspace("ws_writer_credits", true), SHOTS);
  const drafted = await (await shots(post("http://localhost/api/atomik/shots/draft", { projectId: "p1", scene: 1 }))).json();
  expect(drafted.shots).toHaveLength(2);
  expect(drafted.writingCredits).toBe(6);
  expect(JSON.stringify(drafted)).not.toMatch(/usd/i);

  const rewritten = await writerRoutes(workspace("ws_writer_credits_2", true), JSON.stringify({ title: "Platform", secs: 12, prose: "Rain, harder now." }));
  const one = await (await rewritten.scene(post("http://localhost/api/atomik/treatment/scene", { projectId: "p1", n: 1 }))).json();
  expect(one.scene.prose).toContain("Rain");
  expect(one.writingCredits).toBe(6);
  expect(JSON.stringify(one)).not.toMatch(/usd/i);
});

test("a migrated workspace receives retail credits and no vendor amounts", async () => {
  const { shots } = await writerRoutes(workspace("ws_writer_usd", false), SHOTS);
  const drafted = await (await shots(post("http://localhost/api/atomik/shots/draft", { projectId: "p1", scene: 1 }))).json();
  expect(drafted.costUsd).toBeUndefined();
  expect(drafted.writingCredits).toBe(6);
  expect(drafted.sceneUsd).toBeUndefined();
  expect(drafted.shots.every((s: Record<string, unknown>) => !("takeUsd" in s))).toBe(true);
});
