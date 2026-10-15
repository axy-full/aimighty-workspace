import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

/**
 * /api/health, owner's decision of 14 Oct 2026: "make the anonymous response minimal (ok + commit only) and keep the detail for the platform owner when signed in".
 * Anyone, signed in or not, gets exactly { ok, commit } (503 when not ok, never cached); only the platform owner (the console's own gate, lib/auth.ts isPlatformOwner,
 * run for real here) gets the briefing. A member of any workspace is not the platform owner: the dispatch log it carries is the platform's, across workspaces.
 * The caller of the heartbeat route is recorded as "scheduler" only for our own scheduled task. Nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-health-minimal-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const OWNER = { id: "u_owner", email: "owner-health@example.test" }, MEMBER = { id: "u_member", email: "member-health@example.test" };
const nativeRequire = createRequire(path.resolve("package.json"));
let before: Record<string, string | undefined> = {};
test.beforeEach(() => { before = { SUPER_ADMIN_EMAIL: process.env.SUPER_ADMIN_EMAIL, ENGINE_MOCK: process.env.ENGINE_MOCK }; process.env.SUPER_ADMIN_EMAIL = OWNER.email; delete process.env.ENGINE_MOCK; });
test.afterEach(() => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

/** The health route with its collaborators stood in, except the owner gate, which is the real one. */
async function health(who: "anonymous" | "member" | "owner", options: { databaseDown?: boolean; mock?: boolean; deep?: boolean } = {}) {
  const { isPlatformOwner } = await import("../../lib/auth");
  const user = who === "owner" ? OWNER : who === "member" ? MEMBER : null;
  const ctx = user ? { user, workspace: { id: "ws_client", name: "A client's studio" } } : null;
  const database = { execute: async () => { if (options.databaseDown) throw new Error("SECRET_DATABASE_URL"); return { rows: [{ saved: 3, atrisk: 1 }] }; } };
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/providers": { PROVIDERS: [{ id: "vendor" }], providerConfigured: () => true, providerVia: () => "key" },
    "@/lib/auth": { currentContext: async () => ctx, isPlatformOwner, requireSuperAdmin: async () => (who === "owner" ? { user } : { response: Response.json({ error: "Forbidden" }, { status: 403 }) }) },
    "@/lib/tenant": { runInTenant: async (_ws: unknown, fn: () => unknown) => fn() },
    "@/lib/platform": { platformReady: async () => undefined, platformDb: () => database, legacyWorkspace: async () => null },
    "@/lib/db": { ready: async () => undefined, db: () => database },
    "@/lib/vendorKeys": { vendorKey: () => null },
    "@/lib/settings": { allSettings: async () => ({ lastCronAt: String(Date.now() - 60_000), lastCronBy: "scheduler", lastCronAgent: "vercel-cron/1.0", lastCronStatus: "ok" }) },
    "@/lib/storage/backend": { backendKind: () => "r2", cloudBackend: () => ({ put: async () => undefined, presignGet: async () => "https://private.example/p", del: async () => undefined }) },
    "@/lib/mail": { mailConfigured: () => true, mailFrom: () => "Studio <hello@example.test>" },
    "@/lib/mock": { engineMock: () => Boolean(options.mock) },
    "@/lib/dispatch": { dispatchMode: () => "native" },
    "@/lib/deployment": { deployedCommit: () => "0123456789abcdef0123456789abcdef01234567" },
    "@/lib/dispatch-log": { recentDispatches: async () => [{ id: "r1", eventId: "render-other-workspace-gen_1", phase: "send", outcome: "sent", status: 202, workspaceId: "ws_other", createdAt: 1 }] },
    "@vercel/blob": { put: async () => ({ url: "https://private.example/x" }), del: async () => undefined },
  };
  const source = ts.transpileModule(readFileSync(path.resolve("app/api/health/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { GET?: (req: Request) => Promise<Response> } = {};
  vm.runInNewContext(source, { exports, require: (name: string) => mocks[name] ?? nativeRequire(name), process: { env: { NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: "SECRET" } }, URL, Response, Buffer, Uint8Array, AbortSignal, fetch: async () => new Response(new Uint8Array([48, 49]), { status: 206, headers: { "Content-Range": "bytes 0-1/10" } }) });
  return exports.GET!(new Request(`https://example.test/api/health${options.deep ? "?deep=1" : ""}`));
}

test("anonymous: exactly ok and the commit, never cached; 503 when it is not ok", async () => {
  const res = await health("anonymous");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ ok: true, commit: "0123456" });
  const down = await health("anonymous", { databaseDown: true });
  expect(down.status).toBe(503);
  expect(down.headers.get("cache-control")).toBe("no-store");
  const text = await down.text();
  expect(JSON.parse(text)).toEqual({ ok: false, commit: "0123456" });
  expect(text).not.toContain("SECRET");
});

test("an ordinary member of a client workspace gets the same two fields: no workspace name, no dispatch log, no providers", async () => {
  const res = await health("member");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: true, commit: "0123456" });
  for (const leaked of ["A client", "ws_client", "ws_other", "render-other-workspace", "vendor", "hello@example.test", "videosSaved"]) expect(text).not.toContain(leaked);
  expect(JSON.parse(await (await health("member", { databaseDown: true })).text())).toEqual({ ok: false, commit: "0123456" });
});

test("the platform owner, signed in, gets the full briefing; and a mocked-engine server says so to anyone, a real one never", async () => {
  const res = await health("owner");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, commit: "0123456", database: "local-file", dispatch: { mode: "native", recent: [{ eventId: "render-other-workspace-gen_1" }] }, workspace: { id: "ws_client" }, videosSaved: 3, videosAtRisk: 1, providers: [{ id: "vendor", configured: true }], mail: { configured: true } });
  /* The cron line says who ran it, and no longer an agent the code stopped writing. */
  expect(body.cron).toMatchObject({ by: "scheduler", healthy: true });
  expect(body.cron).not.toHaveProperty("agent");
  expect(JSON.stringify(body)).not.toContain("vercel-cron");
  expect(await (await health("anonymous", { mock: true })).json()).toEqual({ ok: true, mock: true, commit: "0123456" });
});

test("?deep=1 is unchanged: the platform owner only, and a member or a visitor is refused", async () => {
  expect((await health("anonymous", { deep: true })).status).toBe(403);
  expect((await health("member", { deep: true })).status).toBe(403);
  expect((await health("owner", { deep: true })).status).toBe(200);
});

test("the heartbeat's caller is 'scheduler' for our own scheduled task and 'manual' for anything else: the route and the task use the same literal", async () => {
  const route = readFileSync(path.resolve("app/api/cron/sync/route.ts"), "utf8");
  const task = readFileSync(path.resolve("ops/selfhost/cron-sync.mjs"), "utf8");
  const agent = /user-agent"\)\?\.trim\(\) === "([^"]+)" \? "scheduler" : "manual"/.exec(route)?.[1];
  expect(agent).toBe("particl-scheduler/1");
  /* The task that calls the route names itself that, and nothing in the route knows Vercel's agent any more. */
  expect(task).toContain(`"user-agent": "${agent}"`);
  expect(route).not.toMatch(/vercel-cron/i);
});
