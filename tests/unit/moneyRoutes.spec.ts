import { test, expect } from "@playwright/test";
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
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

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
  const ws = workspace("ws_usage", false);
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
    "@/lib/creditSql": await import("../../lib/creditSql"),
    "@/lib/creditUsage": { creditUsage: async () => ({}), creditUsageSummary: async () => ({}) },
    "@/lib/credits": await import("../../lib/credits"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/creditTerms": await import("../../lib/creditTerms"),
    "@/lib/memo": { memoGet: () => null, memoPut: () => {} },
  };
  const usage = load<{ GET: Handler }>("app/api/usage/route.ts", modules).GET;
  const summary = load<{ GET: Handler }>("app/api/usage/summary/route.ts", modules).GET;
  const reading = Date.now() - 60_000;
  await runInTenant(ws, async () => {
    await ready();
    const take = `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,provider,cost_usd,refine_model,refine_cost_usd,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    await db().batch([
      { sql: take, args: ["g1", "dreamina-seedance-2-5-260628", "one", "{}", "succeeded", reading - 1_000, reading - 1_000, "video", "byteplus", 1, null, null, 0] },
      { sql: take, args: ["g2", "dreamina-seedance-2-5-260628", "two", "{}", "succeeded", reading - 1_000, reading - 1_000, "video", "byteplus", 0.5, null, null, 1] },
      { sql: take, args: ["g3", "dreamina-seedance-2-5-260628", "three", "{}", "queued", reading + 1_000, reading + 1_000, "video", "byteplus", null, "anthropic/claude-test", 0.03, 1] },
      { sql: `INSERT INTO atomik_chats(id,created_at,updated_at,deleted,text_cost_usd) VALUES('c1',?,?,1,0.2)`, args: [reading, reading] },
      { sql: `INSERT INTO atomik_messages(id,chat_id,role,cost_usd,created_at) VALUES('m1','c1','assistant',0.2,?)`, args: [reading + 1_000] },
    ]);
    await recordCheck({ provider: "vercel", balanceUsd: 10, spendUsd: 2, balanceCredits: null, spendCredits: null, note: "", checkedAt: reading, userId: "owner" });
  });

  const body = await (await usage(new Request("http://localhost/api/usage"))).json();
  const byteplus = body.vendors.find((v: { id: string }) => v.id === "byteplus");
  // The deleted take was paid for: it stays spent.
  expect(byteplus.renderSpend).toBeCloseTo(1.5, 6);
  const vercel = body.vendors.find((v: { id: string }) => v.id === "vercel");
  // The hidden chat's turn and the prompt written after the reading both come off the reading.
  expect(vercel.promptSpend).toBeCloseTo(0.23, 6);
  expect(vercel.anchor.sinceUsd).toBeCloseTo(0.23, 6);
  expect(vercel.remaining).toBeCloseTo(10 - 0.23, 6);
  expect(vercel.spent).toBeCloseTo(2 + 0.23, 6);

  const brief = await (await summary(new Request("http://localhost/api/usage/summary"))).json();
  expect(brief.spentUsd).toBeCloseTo(1.53, 6);
  // A hidden take is not rendering, whatever its row says.
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

test("a workspace that pays its vendors keeps the writing's dollars, and no take is priced by the route", async () => {
  const { shots } = await writerRoutes(workspace("ws_writer_usd", false), SHOTS);
  const drafted = await (await shots(post("http://localhost/api/atomik/shots/draft", { projectId: "p1", scene: 1 }))).json();
  expect(drafted.costUsd).toBeCloseTo(0.4, 6);
  expect(drafted.writingCredits).toBeUndefined();
  expect(drafted.sceneUsd).toBeUndefined();
  expect(drafted.shots.every((s: Record<string, unknown>) => !("takeUsd" in s))).toBe(true);
});
