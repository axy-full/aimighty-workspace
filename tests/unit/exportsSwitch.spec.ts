import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as zod from "zod";
import { loadRoute } from "../helpers/routeModule";
import type { TenantWorkspace } from "../../lib/tenant";

/* REMOTION_EXPORTS is OFF in production until the screens exist and the owner has tested it. Off: the routes answer
   404, the tools are not offered, the recovery pass does nothing, and nothing is admitted, written or dispatched. */
const directory = mkdtempSync(path.join(tmpdir(), "export-switch-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const saved = process.env.REMOTION_EXPORTS;
test.beforeEach(() => { delete process.env.REMOTION_EXPORTS; });
test.afterAll(() => { if (saved === undefined) delete process.env.REMOTION_EXPORTS; else process.env.REMOTION_EXPORTS = saved; });

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });

test("the switch is on only for 1, on, true or yes", async () => {
  const { exportsEnabled } = await import("../../lib/exports/switch");
  expect([undefined, "", "0", "off", "false", "no", "2", "enabled", " "].map((value) => exportsEnabled({ REMOTION_EXPORTS: value }))).toEqual(Array(9).fill(false));
  expect(["1", "on", "ON", "true", "True", " yes "].map((value) => exportsEnabled({ REMOTION_EXPORTS: value }))).toEqual(Array(6).fill(true));
  expect(exportsEnabled({})).toBe(false);
});

test("off: nothing is admitted, read, run, recovered or dispatched, and no table is made", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const jobs = await import("../../lib/exports/jobs");
  const { enqueueExport } = await import("../../lib/exports/dispatch");
  await runInTenant(workspace("off"), async () => {
    await ready();
    const request = { requestId: "request-off-0001", composition: "title-card" as const, props: { aspect: "16:9", card: { title: "Hello" } } };
    await expect(jobs.createExport(request, { id: "u_test" })).rejects.toMatchObject({ status: 404 });
    await expect(jobs.getExport("u_test", "export_" + "a".repeat(32))).rejects.toMatchObject({ status: 404 });
    await expect(jobs.listExports("u_test")).rejects.toMatchObject({ status: 404 });
    await expect(jobs.cancelExport("u_test", "export_" + "a".repeat(32))).rejects.toMatchObject({ status: 404 });
    await expect(jobs.retryExport("u_test", "export_" + "a".repeat(32))).rejects.toMatchObject({ status: 404 });
    expect(await jobs.runExport("export_" + "a".repeat(32))).toBeUndefined();
    expect(await jobs.pendingExports()).toEqual([]);
    expect(await jobs.recoverExports({})).toEqual({ attempted: 0, failed: 0, deferred: 0 });
    expect(await enqueueExport("export_" + "a".repeat(32))).toBe(false);
    const tables = (await db().execute("SELECT name FROM sqlite_master WHERE name='export_jobs'")).rows;
    expect(tables).toEqual([]);
  });
});

test("off, the export tools are not offered and cannot be called; on, they are, and the workspace tools are unchanged", async () => {
  const { TOOLS, toolsOffered, runTool, EXPORT_TOOLS } = await import("../../lib/mcp");
  expect(toolsOffered({})).toBe(TOOLS);
  expect(toolsOffered({ REMOTION_EXPORTS: "off" }).map((tool) => tool.name)).not.toContain("export_video");
  expect(toolsOffered({ REMOTION_EXPORTS: "1" }).map((tool) => tool.name)).toEqual([...TOOLS.map((t) => t.name), "export_video", "assemble_film", "export_film", "get_export", "cancel_export"]);
  expect(EXPORT_TOOLS.map((tool) => tool.name)).toEqual(["export_video", "assemble_film", "export_film", "get_export", "cancel_export"]);
  const calls: string[] = [];
  const call = (async (pathname: string) => { calls.push(pathname); return {}; }) as never;
  for (const name of ["export_video", "assemble_film", "export_film", "get_export", "cancel_export"]) {
    await expect(runTool(name, { composition: "title-card", props: {} as never, id: "x" }, call, "https://app.test")).rejects.toThrow("Unknown tool");
  }
  expect(calls).toEqual([]);
});

test("on, an outside agent runs the export tool over MCP: one POST to the same route, free, and a link to collect it", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { runTool, EXPORT_TOOLS } = await import("../../lib/mcp");
  const calls: { path: string; init: { method?: string; body?: unknown } }[] = [];
  const call = (async (pathname: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path: pathname, init });
    if (pathname === "/api/exports") return { job: { id: "export_" + "b".repeat(32), status: "queued", queueLine: "Export queued — 2 ahead of you", error: null, outputs: [] } };
    if (init.method === "PATCH") return { job: { id: "export_" + "b".repeat(32), status: "cancelled", queueLine: null, error: "Cancelled. Nothing billed.", outputs: [] } };
    return { job: { id: "export_" + "b".repeat(32), status: "ready", queueLine: null, error: null, outputs: [{ url: "/api/uploads/export_b_video", filename: "export-bbbbbbbb.mp4" }] } };
  }) as never;
  const props = { aspect: "9:16", clip: { source: { take: "take_1", hasAudio: true }, cues: [] }, captionStyle: "bold" };
  const started = await runTool("export_video", { composition: "captions", props: props as never, request_id: "agent-request-0001" }, call, "https://app.test");
  expect(calls[0]).toEqual({ path: "/api/exports", init: { method: "POST", body: { requestId: "agent-request-0001", composition: "captions", props } } });
  expect(started).toContain("Export queued — 2 ahead of you");
  expect(started).toContain("price: Free (0 cr)");
  const done = await runTool("get_export", { id: "export_" + "b".repeat(32) }, call, "https://app.test");
  expect(done).toContain("Ready");
  expect(done).toContain("https://app.test/api/uploads/export_b_video");
  expect(await runTool("cancel_export", { id: "export_" + "b".repeat(32) }, call, "https://app.test")).toBe("Cancelled — Cancelled. Nothing billed.");
  // The tool says it is free and never names a price, a vendor or a key.
  const text = JSON.stringify(EXPORT_TOOLS);
  expect(text).toContain("Free");
  expect(text).not.toMatch(/\bcredits? (?!it costs no)\d|\$\d|REMOTION_|secret/i);
});

test("the tool declares what rule 11 asks: id, who may call, key, a price of 0, and names the missing key", async () => {
  const { EXPORT_TOOL, exportToolAvailability } = await import("../../lib/exports/tool");
  expect(EXPORT_TOOL).toMatchObject({ id: "export_video", kind: "app-action", callers: "render", route: "/api/exports", priceLabel: "Free" });
  expect(EXPORT_TOOL.price()).toEqual({ credits: 0, label: "Free" });
  expect(EXPORT_TOOL.compositions).toEqual(["captions", "title-card", "end-card", "reframe", "cutdown", "final"]);
  expect(exportToolAvailability({})).toEqual({ available: false, reason: "Exports are not switched on for this deployment." });
  const missing = exportToolAvailability({ REMOTION_EXPORTS: "1" });
  expect(missing.available).toBe(false);
  expect(missing.reason).toContain("REMOTION_WORKER_URLS");
  expect(missing.reason).toContain("REMOTION_WORKER_SECRETS");
  const secret = "s".repeat(40);
  expect(exportToolAvailability({ REMOTION_EXPORTS: "1", REMOTION_WORKER_URLS: "http://remotion-1:8790", REMOTION_WORKER_SECRETS: secret })).toEqual({ available: true, reason: null });
  expect(JSON.stringify(missing)).not.toContain(secret);
});

test("worker settings: one to three origins, one secret each, nothing else accepted; limits are bounded and are never a price", async () => {
  const { exportWorkerConfig, exportLimits, exportWorkerSlots } = await import("../../lib/exports/limits");
  const secret = "x".repeat(32);
  expect(exportWorkerConfig({ REMOTION_WORKER_URLS: "http://remotion-1:8790", REMOTION_WORKER_SECRETS: secret })).toEqual({ urls: ["http://remotion-1:8790"], secrets: [secret] });
  expect(exportWorkerConfig({ REMOTION_WORKER_URLS: "http://a:1, http://b:1", REMOTION_WORKER_SECRETS: `${secret}, ${"y".repeat(32)}` })?.urls).toEqual(["http://a:1", "http://b:1"]);
  for (const env of [{}, { REMOTION_WORKER_URLS: "http://a:1" }, { REMOTION_WORKER_URLS: "http://a:1", REMOTION_WORKER_SECRETS: "short" }, { REMOTION_WORKER_URLS: "http://a:1,http://b:1", REMOTION_WORKER_SECRETS: secret }, { REMOTION_WORKER_URLS: "ftp://a", REMOTION_WORKER_SECRETS: secret }, { REMOTION_WORKER_URLS: "http://user:pw@a:1", REMOTION_WORKER_SECRETS: secret }, { REMOTION_WORKER_URLS: "http://a:1/path", REMOTION_WORKER_SECRETS: secret }, { REMOTION_WORKER_URLS: "http://a:1,http://a:1", REMOTION_WORKER_SECRETS: `${secret},${secret}` }, { REMOTION_WORKER_URLS: "http://a:1,http://b:1,http://c:1,http://d:1", REMOTION_WORKER_SECRETS: [secret, secret, secret, secret].join(",") }]) {
    expect(exportWorkerConfig(env as never), JSON.stringify(env)).toBeNull();
  }
  expect(exportWorkerSlots({})).toBe(1);
  expect(exportLimits({})).toEqual({ maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 6, runTimeoutMs: 200_000, queueExpiryMs: 1_800_000 });
  /* The queue's expiry is a constant: the old setting's name changes nothing. */
  expect(exportLimits({ REMOTION_EXPORT_QUEUE_EXPIRY_MS: "60000" }).queueExpiryMs).toBe(1_800_000);
  expect(exportLimits({ REMOTION_EXPORT_QUEUE_EXPIRY_MS: "86400000" }).queueExpiryMs).toBe(30 * 60_000);
  expect(readFileSync("lib/exports/limits.ts", "utf8")).not.toMatch(/bounded\(env, "REMOTION_EXPORT_QUEUE_EXPIRY_MS"/);
  expect(exportLimits({ REMOTION_EXPORT_MAX_RUNNING: "2", REMOTION_EXPORT_MAX_PER_HOUR: "12", REMOTION_EXPORT_RUN_TIMEOUT_MS: "600000" })).toMatchObject({ maxRunningPerWorkspace: 2, maxPerHourPerWorkspace: 12, runTimeoutMs: 600_000 });
  // Out of range or not a whole number: the default, never a surprise.
  expect(exportLimits({ REMOTION_EXPORT_MAX_RUNNING: "50", REMOTION_EXPORT_MAX_PER_HOUR: "0", REMOTION_EXPORT_RUN_TIMEOUT_MS: "x" })).toMatchObject({ maxRunningPerWorkspace: 1, maxPerHourPerWorkspace: 6, runTimeoutMs: 200_000 });
});

/* ---- the routes ---- */

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
function routes(overrides: { requireRender?: () => Promise<unknown>; create?: (...a: unknown[]) => Promise<unknown> } = {}) {
  const log: string[] = [];
  const auth = {
    withTenant: <T>(handler: T) => { log.push("withTenant"); return handler; },
    requireRender: async () => { log.push("requireRender"); return overrides.requireRender ? overrides.requireRender() : { user: { id: "u_test" } }; },
    requireUser: async () => { log.push("requireUser"); return { user: { id: "u_test" } }; },
  };
  const job = { id: "export_" + "c".repeat(32), status: "queued" };
  const jobs = {
    createExport: async (...args: unknown[]) => { log.push("createExport"); return overrides.create ? overrides.create(...args) : { job, scheduled: true, duplicate: false }; },
    listExports: async () => { log.push("listExports"); return [job]; },
    getExport: async () => { log.push("getExport"); return job; },
    cancelExport: async () => { log.push("cancelExport"); return { ...job, status: "cancelled" }; },
    retryExport: async () => { log.push("retryExport"); return job; },
  };
  const schedule = { scheduleExport: async (id: string) => { log.push(`schedule ${id}`); } };
  return (async () => {
    const http = await import("../../lib/exports/http");
    const contract = await import("../../lib/exports/contract");
    const shared = {
      zod,
      "@/lib/auth": auth,
      "@/lib/requestBody": { readBoundedText: async (req: Request) => req.text() },
      "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => { log.push("sampleWorkspaceOff"); return null; } },
      "@/lib/exports/contract": contract,
      "@/lib/exports/http": http,
      "@/lib/exports/jobs": jobs,
      "@/lib/exports/schedule": schedule,
    };
    const collection = loadRoute<{ GET: Handler; POST: Handler }>("app/api/exports/route.ts", shared);
    const one = loadRoute<{ GET: Handler; PATCH: Handler }>("app/api/exports/[id]/route.ts", shared);
    return { collection, one, log, job };
  })();
}
const post = (body: unknown) => new Request("https://app.test/api/exports", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const valid = { requestId: "request-route-0001", composition: "title-card", props: { aspect: "16:9", card: { title: "Hello" } } };

test("off, every export route answers 404 before the session, the body or anything else is touched", async () => {
  const { collection, one, log } = await routes();
  for (const response of [await collection.GET(new Request("https://app.test/api/exports")), await collection.POST(post(valid)), await one.GET(new Request("https://app.test/x"), { params: Promise.resolve({ id: "export_" + "c".repeat(32) }) }), await one.PATCH(new Request("https://app.test/x", { method: "PATCH", body: '{"action":"cancel"}' }), { params: Promise.resolve({ id: "export_" + "c".repeat(32) }) })]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  }
  expect(log.filter((line) => line !== "withTenant")).toEqual([]);
});

test("on, POST admits and schedules once (202); a repeat is 200 and schedules nothing; a refusal passes through untouched", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { collection, log, job } = await routes();
  const first = await collection.POST(post(valid));
  expect(first.status).toBe(202);
  expect((await first.json()).job.id).toBe(job.id);
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  expect(log.filter((line) => line !== "withTenant")).toEqual(["requireRender", "sampleWorkspaceOff", "createExport", `schedule ${job.id}`]);
  const repeated = await routes({ create: async () => ({ job, scheduled: true, duplicate: true }) });
  const again = await repeated.collection.POST(post(valid));
  expect(again.status).toBe(200);
  expect(repeated.log.some((line) => line.startsWith("schedule"))).toBe(false);
  // A token that may only prepare, or a suspended workspace, is refused by requireRender and nothing else runs.
  const refused = await routes({ requireRender: async () => ({ response: Response.json({ error: "This token prepares jobs; a person approves each in Particl." }, { status: 403 }) }) });
  const denied = await refused.collection.POST(post(valid));
  expect(denied.status).toBe(403);
  expect(refused.log.filter((line) => line !== "withTenant")).toEqual(["requireRender"]);
});

test("on, POST refuses what is not a well-formed request, with a plain status", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { collection, log } = await routes();
  for (const body of ["not json", {}, { ...valid, composition: "fixture-clip" }, { ...valid, composition: "evil" }, { ...valid, requestId: "short" }, { ...valid, price: 5 }, { ...valid, props: "x" }]) {
    const response = await collection.POST(post(body));
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect(log.includes("createExport")).toBe(false);
  const { ExportError } = await import("../../lib/exports/contract");
  const limited = await routes({ create: async () => { throw new ExportError("Try again in 12 minutes.", 429, 720); } });
  const response = await limited.collection.POST(post(valid));
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("720");
  const broken = await routes({ create: async () => { throw new Error("secret database detail"); } });
  const failed = await broken.collection.POST(post(valid));
  expect(failed.status).toBe(500);
  expect(JSON.stringify(await failed.json())).not.toContain("secret database detail");
});

test("on, one export: GET its state, PATCH cancel or retry (retry is scheduled again); a bad id is 404", async () => {
  process.env.REMOTION_EXPORTS = "1";
  const { one, log, job } = await routes();
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  expect((await one.GET(new Request("https://app.test/x"), ctx(job.id))).status).toBe(200);
  expect((await one.GET(new Request("https://app.test/x"), ctx("../etc"))).status).toBe(404);
  const patch = (action: unknown) => one.PATCH(new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify({ action }) }), ctx(job.id));
  expect(((await (await patch("cancel")).json()).job.status)).toBe("cancelled");
  expect((await patch("retry")).status).toBe(202);
  expect(log).toContain(`schedule ${job.id}`);
  expect((await patch("delete")).status).toBe(400);
});

test("the routes are for render-scope tokens and people: never the prepare-token door, never a spend marker", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["app/api/exports/route.ts", "app/api/exports/[id]/route.ts"]) {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/preparedJobs|mcpTransport|readOnlyPostTransport/);
    expect(source).toMatch(/whenOn\(withTenant\(/);
  }
  expect(readFileSync("app/api/exports/route.ts", "utf8")).toContain("requireRender");
});
