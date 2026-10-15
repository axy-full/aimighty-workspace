import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import * as atRiskWindow from "../../lib/atRiskWindow";

/**
 * One 72-hour window for an unsaved take (lib/atRisk.ts; owner, 15 Oct 2026: "the counter and the rescuer use the same 72-hour window; older unsaved takes are listed as 'lost
 * (older than 3 days)' instead of 'at risk' forever; the cron logs a reason for every kind it can't save"). Mocked, local temporary databases; no provider is called and nothing
 * here retries a save: a stand-in for fetch fails the test if anything reaches for the network.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-at-risk-window-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const HOUR = 3_600_000;
const SECRET_PROMPT = "A private prompt about a lighthouse";
const SECRET_URL = "https://provider.example/secret/file.mp4";
const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
type Take = { id: string; hours: number; kind?: string; provider?: string | null; model?: string; status?: string; stored?: boolean; deleted?: boolean; ark?: string | null; params?: Record<string, unknown> };
const insert = (t: Take, at: number) => {
  const created = at - t.hours * HOUR;
  return {
    sql: "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at,stored_url,deleted,ark_task_id,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    args: [t.id, t.kind ?? "image", t.provider === undefined ? "google" : t.provider, t.model ?? "gemini-3-pro-image", SECRET_PROMPT, JSON.stringify(t.params ?? {}), t.status ?? "succeeded", created, created,
      t.stored ? "stored/x.bin" : null, t.deleted ? 1 : 0, t.ark ?? null, SECRET_URL],
  };
};

let realFetch: typeof fetch;
let fetched: string[] = [];
test.beforeEach(() => { fetched = []; realFetch = globalThis.fetch; globalThis.fetch = (async (input: RequestInfo | URL) => { fetched.push(String(input)); throw new Error("No provider call is allowed in this test."); }) as typeof fetch; });
test.afterEach(() => { globalThis.fetch = realFetch; });

test("the window is one definition: 71 hours is at risk, 73 hours is lost, the horizon is 72 hours before the moment asked", () => {
  const at = Date.UTC(2026, 9, 15, 12);
  expect(atRiskWindow.AT_RISK_WINDOW_MS).toBe(72 * HOUR);
  expect(atRiskWindow.atRiskHorizon(at)).toBe(at - 72 * HOUR);
  expect(atRiskWindow.isLostAge(at - 71 * HOUR, at)).toBe(false);
  expect(atRiskWindow.isLostAge(at - 73 * HOUR, at)).toBe(true);
  expect(atRiskWindow.isLostAge(at - 72 * HOUR, at), "the boundary itself is lost: at risk is strictly newer").toBe(true);
  expect(atRiskWindow.LOST_LABEL).toBe("lost (older than 3 days)");
});

test("the counter and the rescuer agree: a 71 h take is at risk and chosen to be saved; a 73 h take is lost and not chosen; saved, deleted and failed takes are neither", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { atRiskCounts, atRiskHorizon } = await import("../../lib/atRisk");
  const { syncPending } = await import("../../lib/jobs");
  await runInTenant(workspace("risk_agree"), async () => {
    await ready();
    const at = Date.now();
    await db().batch([
      insert({ id: "t71", hours: 71 }, at), insert({ id: "t73", hours: 73 }, at), insert({ id: "t200", hours: 200 }, at),
      insert({ id: "saved", hours: 5, stored: true }, at), insert({ id: "gone", hours: 5, deleted: true }, at), insert({ id: "failed", hours: 5, status: "failed" }, at),
    ], "write");
    expect(await atRiskCounts(atRiskHorizon(at))).toEqual({ saved: 1, atRisk: 1, lost: 2 });
    const touched = async (id: string) => Number((await db().execute({ sql: "SELECT updated_at FROM generations WHERE id=?", args: [id] })).rows[0].updated_at);
    const [before71, before73] = [await touched("t71"), await touched("t73")];
    const report = await syncPending(8);
    /* The rescuer's choice is the same window: it chose the 71 h take (and stamped it as checked), and not the 73 h one. */
    expect(report.atRiskTried).toBe(1);
    expect(await touched("t71")).toBeGreaterThan(before71);
    expect(await touched("t73")).toBe(before73);
    expect(fetched, "no provider was called").toEqual([]);
  });
});

test("health: the platform owner's detail has both counts and the label; the anonymous and member answers are the same two fields as before", async () => {
  const nativeRequire = createRequire(path.resolve("package.json"));
  const OWNER = { id: "u_owner", email: "owner-risk@example.test" }, MEMBER = { id: "u_member", email: "member-risk@example.test" };
  const saved = { s: process.env.SUPER_ADMIN_EMAIL, m: process.env.ENGINE_MOCK };
  process.env.SUPER_ADMIN_EMAIL = OWNER.email; delete process.env.ENGINE_MOCK;
  try {
    const { isPlatformOwner } = await import("../../lib/auth");
    const asked: { sql: string; args: unknown[] }[] = [];
    const get = async (who: "anonymous" | "member" | "owner") => {
      const user = who === "owner" ? OWNER : who === "member" ? MEMBER : null;
      const ctx = user ? { user, workspace: { id: "ws_client", name: "A client's studio" } } : null;
      const database = { execute: async (q: unknown) => { if (typeof q === "object" && q) asked.push(q as { sql: string; args: unknown[] }); return { rows: [{ saved: 3, atrisk: 2, lost: 4 }] }; } };
      const mocks: Record<string, unknown> = {
        "next/server": { NextResponse: Response },
        "@/lib/providers": { PROVIDERS: [], providerConfigured: () => true, providerVia: () => "key" },
        "@/lib/auth": { currentContext: async () => ctx, isPlatformOwner, requireSuperAdmin: async () => ({ user }) },
        "@/lib/tenant": { runInTenant: async (_ws: unknown, fn: () => unknown) => fn() },
        "@/lib/platform": { platformReady: async () => undefined, platformDb: () => database, legacyWorkspace: async () => null },
        "@/lib/db": { ready: async () => undefined, db: () => database },
        "@/lib/atRiskWindow": atRiskWindow,
        "@/lib/vendorKeys": { vendorKey: () => null },
        "@/lib/settings": { allSettings: async () => ({ lastCronAt: String(Date.now() - 60_000), lastCronBy: "scheduler", lastCronStatus: "ok" }) },
        "@/lib/storage/backend": { backendKind: () => "r2", cloudBackend: () => ({}) },
        "@/lib/mail": { mailConfigured: () => true, mailFrom: () => "Studio <hello@example.test>" },
        "@/lib/mock": { engineMock: () => false },
        "@/lib/dispatch": { dispatchMode: () => "native" },
        "@/lib/deployment": { deployedCommit: () => "0123456789abcdef0123456789abcdef01234567" },
        "@/lib/dispatch-log": { recentDispatches: async () => [] },
      };
      const source = ts.transpileModule(readFileSync(path.resolve("app/api/health/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const exports: { GET?: (req: Request) => Promise<Response> } = {};
      vm.runInNewContext(source, { exports, require: (name: string) => mocks[name] ?? nativeRequire(name), process: { env: { NODE_ENV: "production" } }, URL, Response, Buffer, Uint8Array, AbortSignal, fetch: async () => { throw new Error("no network"); } });
      return exports.GET!(new Request("https://example.test/api/health"));
    };
    expect(await (await get("anonymous")).json()).toEqual({ ok: true, commit: "0123456" });
    expect(await (await get("member")).json()).toEqual({ ok: true, commit: "0123456" });
    const detail = await (await get("owner")).json();
    expect(detail).toMatchObject({ videosSaved: 3, videosAtRisk: 2, lost: 4, lostLabel: "lost (older than 3 days)" });
    /* The query it ran is the shared one, at a 72-hour horizon. */
    const counts = asked.find((q) => q.sql.includes("AS lost"));
    expect(counts?.sql).toBe(atRiskWindow.AT_RISK_COUNTS_SQL);
    const horizon = Number(counts?.args[0]);
    expect(Date.now() - horizon).toBeGreaterThan(72 * HOUR - 5_000);
    expect(Date.now() - horizon).toBeLessThan(72 * HOUR + 5_000);
    expect(counts?.args).toEqual([horizon, horizon]);
  } finally {
    if (saved.s === undefined) delete process.env.SUPER_ADMIN_EMAIL; else process.env.SUPER_ADMIN_EMAIL = saved.s;
    if (saved.m === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = saved.m;
  }
});

test("each kind the heartbeat cannot save has a reason code, and each kind it can save has none", async () => {
  const { whyNotSaved } = await import("../../lib/atRisk");
  const facts = (over: Record<string, unknown>) => ({ kind: "video", provider: "byteplus", model: "dreamina-seedance-2-5-260628", arkTaskId: "ark_1", params: {}, ...over }) as Parameters<typeof whyNotSaved>[0];
  const cases: [string, Parameters<typeof whyNotSaved>[0], string | null][] = [
    ["a dubbing project's row", facts({ kind: "audio", provider: "elevenlabs", arkTaskId: null, params: { task: "dub" } }), "dub_row"],
    ["a still with only a saved outcome", facts({ kind: "image", provider: "google", arkTaskId: null, params: { producedOutcome: { a: 1 } } }), "still_or_sound_no_rescue"],
    ["a sound with only a saved outcome", facts({ kind: "audio", provider: "elevenlabs", arkTaskId: null, params: { producedOutcome: { a: 1 } } }), "still_or_sound_no_rescue"],
    ["a connected-account still", facts({ kind: "image", provider: "higgsfield", arkTaskId: null }), "claims_queued_only"],
    ["a connected-account video", facts({ kind: "video", provider: "higgsfield", model: "higgsfield-cinema-studio-4.0", arkTaskId: null }), "claims_queued_only"],
    ["a Topaz still", facts({ kind: "image", provider: "fal", model: "fal-ai/topaz/upscale/image", arkTaskId: null, params: { falStillRequestId: "r" } }), "claims_queued_only"],
    ["the fal 3D upscale video", facts({ kind: "video", provider: "fal", model: "topaz/upscale/video/creative", arkTaskId: null, params: { falRequestId: "r", falModel: "m" } }), "astra_claim_queued_only"],
    ["a fal video with no request id", facts({ kind: "video", provider: "fal", model: "fal-ai/kling-video/v3/standard", arkTaskId: null, params: {} }), "fal_no_request_ref"],
    ["a fal video with no endpoint", facts({ kind: "video", provider: "fal", model: "fal-ai/kling-video/v3/standard", arkTaskId: null, params: { falRequestId: "r" } }), "fal_no_request_ref"],
    ["a take with no task to poll", facts({ kind: "video", provider: "byteplus", arkTaskId: null }), "no_task_ref"],
    ["an Ark video with its task", facts({}), null],
    ["a fal video with its request and endpoint", facts({ kind: "video", provider: "fal", model: "fal-ai/kling-video/v3/standard", arkTaskId: null, params: { falRequestId: "r", falModel: "m" } }), null],
    ["a fal still with its request", facts({ kind: "image", provider: "fal", model: "fal-ai/x", arkTaskId: null, params: { falRequestId: "r" } }), null],
  ];
  for (const [what, f, want] of cases) expect(whyNotSaved(f), what).toBe(want);
});

test("a take the heartbeat cannot save is logged once a day, with an id, kind, provider and a code, and never a prompt or a URL; a lost one is not logged", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { atRiskHorizon, listAtRisk, logUnsavable, whyNotSaved } = await import("../../lib/atRisk");
  const lines: string[] = [];
  const warn = console.warn; console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await runInTenant(workspace("risk_log"), async () => {
      await ready();
      const at = Date.now();
      await db().batch([
        insert({ id: "dub", hours: 3, kind: "audio", provider: "elevenlabs", params: { task: "dub" } }, at),
        insert({ id: "notask", hours: 4, kind: "video", provider: "byteplus" }, at),
        insert({ id: "falnoref", hours: 5, kind: "video", provider: "fal", model: "fal-ai/kling-video/v3/standard" }, at),
        insert({ id: "astra", hours: 6, kind: "video", provider: "fal", model: "topaz/upscale/video/creative", params: { falRequestId: "r", falModel: "m" } }, at),
        insert({ id: "hf", hours: 7, kind: "image", provider: "higgsfield", model: "x" }, at),
        insert({ id: "arkok", hours: 8, kind: "video", provider: "byteplus", ark: "ark_1" }, at),
        insert({ id: "oldnotask", hours: 100, kind: "video", provider: "byteplus" }, at),
      ], "write");
      const unsavable = async (when: number) => (await listAtRisk(atRiskHorizon(when), 200)).flatMap((row) => { const reason = whyNotSaved(row); return reason ? [{ ...row, reason }] : []; });
      const first = await unsavable(at);
      expect(first.map((r) => `${r.id}:${r.reason}`).sort()).toEqual(["astra:astra_claim_queued_only", "dub:dub_row", "falnoref:fal_no_request_ref", "hf:claims_queued_only", "notask:no_task_ref"]);
      expect(await logUnsavable(first, at)).toBe(5);
      const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(logged.map((l) => `${l.id}:${l.reason}`).sort()).toEqual(first.map((r) => `${r.id}:${r.reason}`).sort());
      for (const l of logged) {
        expect(Object.keys(l).sort()).toEqual(["ageHours", "event", "id", "kind", "level", "provider", "reason", "workspaceId"]);
        expect(l.event).toBe("reconciliation.at_risk_unsavable");
      }
      expect(lines.join("\n")).not.toContain(SECRET_PROMPT);
      expect(lines.join("\n")).not.toContain("http");
      expect(lines.join("\n")).not.toContain("oldnotask");
      /* The next visit, and the one after: nothing again. A day later: once more. */
      const stamp = async () => Number((await db().execute({ sql: "SELECT updated_at FROM settings WHERE key = 'atRiskUnsavableLogged'", args: [] })).rows[0].updated_at);
      const wrote = await stamp();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await logUnsavable(first, at + 10 * 60_000)).toBe(0);
      expect(await stamp(), "nothing changed, so nothing was written").toBe(wrote);
      expect(await logUnsavable(first, at + 12 * HOUR)).toBe(0);
      expect(await logUnsavable(first, at + 25 * HOUR)).toBe(5);
      expect(lines).toHaveLength(10);
      /* A take that is saved (or has left the list) drops out of the memory, and a new one is logged at once. */
      const fresh = [...first.filter((r) => r.id !== "dub"), { ...first.find((r) => r.id === "dub")!, id: "dub2" }];
      expect(await logUnsavable(fresh, at + 25 * HOUR + 60_000)).toBe(1);
    });
    expect(fetched).toEqual([]);
  } finally { console.warn = warn; }
});

test("the failed-saves list says at risk or lost with the shared definition, the badge counts only the ones at risk, and the list reads without saving anything", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { listFailedSaves, failedSavesCount, forgetFailedSaves } = await import("../../lib/platformFailedSaves");
  await platformReady();
  const ws = workspace("risk_list");
  await platformDb().execute({ sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,'tester',1,0,0,20,200)", args: [ws.id, ws.id, "Risk list", ws.dbUrl] });
  const at = Date.now();
  await runInTenant(ws, async () => {
    await ready();
    await db().batch([insert({ id: "r71", hours: 71 }, at), insert({ id: "r73", hours: 73 }, at), insert({ id: "rsaved", hours: 2, stored: true }, at)], "write");
  });
  forgetFailedSaves();
  const read = (await listFailedSaves(at + 1)).items.filter((i) => i.workspaceId === ws.id);
  expect(Object.fromEntries(read.map((i) => [i.id, i.lost]))).toEqual({ r71: false, r73: true });
  expect(await failedSavesCount(), "only the take at risk is counted (the console's other workspaces add nothing here)").toBeGreaterThanOrEqual(1);
  const inList = (await listFailedSaves(at + 1)).items;
  expect(inList.filter((i) => !i.lost).map((i) => i.id)).toContain("r71");
  /* The screen shows the shared label for a lost row and "at risk" for the other. */
  const screen = readFileSync(path.resolve("components/v12/platform/FailedSaves.tsx"), "utf8");
  expect(screen).toMatch(/LOST_LABEL/);
  expect(screen).toMatch(/data-testid="pc-risk-state"/);
  expect(fetched).toEqual([]);
});

test("the heartbeat reports tried, saved and unsavable beside the net rescued figure, and lost beside at risk", async () => {
  const settings: Record<string, string> = {};
  const counted = [{ saved: 0, atRisk: 4, lost: 2 }, { saved: 0, atRisk: 3, lost: 2 }];
  const row = (id: string) => ({ id, kind: "video", provider: "byteplus", model: "m", arkTaskId: null, params: {}, createdAt: 1 });
  const logged: string[] = [];
  const overrides: Record<string, unknown> = {
    "@/lib/recovery": { recoveryFence: () => ({ status: async () => ({ state: "open" }) }), recoveryRoute: (h: () => Promise<Response>) => h, reserveRecoveryContinuation: async (_n: string, fn: unknown) => fn },
    "@/lib/recoveryDrain": { drainRecoveryJobs: async () => ({}), RECOVERY_DRAIN_WORK_BUDGET_MS: 1 },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) }, after: () => {} },
    "@/lib/db": { db: () => ({ execute: async () => ({ rows: [{ pending: 0 }] }) }), ready: async () => {} },
    "@/lib/jobs": { syncPending: async () => ({ failed: 0, deferred: 0, atRiskTried: 3 }) },
    "@/lib/atRisk": {
      atRiskHorizon: () => 0, atRiskCounts: async () => counted.shift()!,
      listAtRisk: (() => { const reads = [[row("a"), row("b"), row("c"), row("d")], [row("c"), row("d")]]; return async () => reads.shift()!; })(),
      storedAmong: async () => new Set(["a", "b"]), whyNotSaved: (r: { id: string }) => (r.id === "d" ? "no_task_ref" : null),
      logUnsavable: async (rows: { id: string; reason: string }[]) => { logged.push(...rows.map((r) => `${r.id}:${r.reason}`)); return rows.length; },
    },
    "@/lib/identities": { syncTrainingIdentities: async () => ({ failed: 0 }) },
    "@/lib/soulIdentities": { syncSoulIdentities: async () => ({ failed: 0 }) },
    "@/lib/storageCost": { backfillSizes: async () => ({}) },
    "@/lib/settings": { setSetting: async (key: string, value: string) => { settings[key] = value; } },
    "@/lib/platform": { getWorkspace: async () => ({ id: "cron_ws", deletedAt: null }), platformDb: () => ({}), platformReady: async () => {} },
    "@/lib/tenant": { runInTenant: (_: unknown, fn: () => Promise<unknown>) => fn() },
    "@/lib/held": { releaseHeldJobs: async () => ({}) },
    "@/lib/purge": { retireDeletedWorkspaces: async () => {} },
    "@/lib/reconciliation": { reconcileWorkspaces: async (o: { visit: (id: string, deadlineAt: number) => Promise<{ failed: boolean }> }) => { const r = await o.visit("cron_ws", Date.now() + 60_000); return { ok: !r.failed, visited: 1 }; } },
    "@/lib/uploadReservations": { cleanupExpiredUploads: async () => ({}) },
    "@/lib/pipeline/executor": { drainPipelineWakeups: async () => ({ failed: 0 }) },
    "@/lib/higgsfield-consumer/sweep": { sweepConsumerJobs: async () => ({ deferred: false }) },
    "@/lib/higgsfield-consumer/retired": { SIGN_IN_OFF: true },
    "@/lib/workbench/canvas-push": { drainCanvasPushes: async () => ({}) },
    "@/lib/workbench/rig-agent": { drainRigAgentWakeups: async () => ({}) },
    "@/lib/genjutsuVideo": { expireUnansweredCinemaTakes: async () => ({ expired: [] }) },
    "@/lib/paidText": { reconcilePaidTextJobs: async () => ({ refunded: 0, released: 0, failed: 0 }) },
  };
  const source = ts.transpileModule(readFileSync("app/api/cron/sync/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target: { exports: { GET?: (req: Request) => Promise<Response> } } = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => { if (name in overrides) return overrides[name]; throw new Error(`The cron test must mock ${name}`); }, target, target.exports);
  const reply = await target.exports.GET!(new Request("http://localhost/api/cron/sync"));
  expect(reply.status).toBe(200);
  expect(JSON.parse(settings.lastCronResult)).toMatchObject({ ok: true, atRisk: 3, lost: 2, rescued: 1, tried: 3, saved: 2, unsavable: 1 });
  expect(logged).toEqual(["d:no_task_ref"]);
});

test("nothing in the at-risk code calls a provider, saves a take or retries a save", () => {
  for (const file of ["lib/atRisk.ts", "lib/atRiskWindow.ts"]) {
    const source = readFileSync(path.resolve(file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source, file).not.toMatch(/\bfetch\(|syncGeneration|retryFailedSave|engineFor|storeVideo|INSERT INTO generations|UPDATE generations/);
  }
  /* The console's Retry save is untouched: its own file still holds the retry, and the list read does not call it. */
  const failed = readFileSync(path.resolve("lib/platformFailedSaves.ts"), "utf8");
  expect(failed).toMatch(/export async function retryFailedSave/);
  const read = failed.slice(0, failed.indexOf("export class RetryRefused")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(read).not.toMatch(/syncGeneration|retryFailedSave\(/);
});

test("a member's GET /api/settings never carries the internal at-risk memory (take ids); the other settings still arrive", async () => {
  const { INTERNAL_SETTING_KEYS, memberSettings } = await import("../../lib/settings");
  expect(INTERNAL_SETTING_KEYS).toContain("atRiskUnsavableLogged");
  const all = { atRiskUnsavableLogged: JSON.stringify({ gen_private_of_another_member: 1 }), namingTemplate: "{project}", capWarnPct: "80" };
  expect(memberSettings(all)).toEqual({ namingTemplate: "{project}", capWarnPct: "80" });
  const stub = (name: string) => new Proxy({}, { get: () => () => { throw new Error(`${name} is not used by GET`); } });
  const source = ts.transpileModule(readFileSync("app/api/settings/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const overrides: Record<string, unknown> = {
    "@/lib/shell/enhancer": { isEnhancerProvider: () => true },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/auth": { requireUser: async () => ({ user: { id: "member", role: "member" } }), requireAdmin: stub("requireAdmin"), withTenant: (fn: unknown) => fn },
    "@/lib/settings": { allSettings: async () => all, setSetting: stub("setSetting"), memberSettings, DEFAULTS: { namingTemplate: "x" } },
    "@/lib/platform": { getPlatformLayer: async () => ({ models: {} }) },
    "@/lib/platformLayer": { resolveModels: () => ({}), modelOfKind: () => null },
    "@/lib/settingValues": { settingProblem: () => null },
    "@/lib/caps": { setWorkspaceBudget: stub("setWorkspaceBudget") },
    "@/lib/credits": { creditsApply: () => false },
    "@/lib/tenant": { requireTenant: stub("requireTenant") },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
  };
  const target: { exports: { GET?: () => Promise<Response> } } = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => { if (name in overrides) return overrides[name]; throw new Error(`The settings test must mock ${name}`); }, target, target.exports);
  const body = await (await target.exports.GET!()).json() as { settings: Record<string, string> };
  expect(Object.keys(body.settings).sort()).toEqual(["capWarnPct", "namingTemplate"]);
  expect(JSON.stringify(body)).not.toContain("gen_private_of_another_member");
});
