import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const nativeRequire = createRequire(path.resolve("package.json"));
function healthFixture(options: { signedIn?: boolean; admin?: boolean; databaseDown?: boolean; dispatchLogDown?: boolean; rangeStatus?: number; cleanupFails?: boolean } = {}) {
  const writes: string[] = [], deletes: string[] = [];
  const ctx = options.signedIn ? { user: { id: "account" }, workspace: { id: "workspace", name: "Workspace" } } : null;
  const database = { execute: async () => { if (options.databaseDown) throw new Error("SECRET_DATABASE_URL"); return { rows: [{ saved: 1, atrisk: 0 }] }; } };
  const mocks: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/providers": { PROVIDERS: [], providerConfigured: () => false, providerVia: () => null },
    "@/lib/auth": { currentContext: async () => ctx, requireSuperAdmin: async () => options.admin ? { user: ctx?.user } : { response: Response.json({ error: "Forbidden" }, { status: 403 }) } },
    "@/lib/tenant": { runInTenant: async (_ws: unknown, fn: () => unknown) => fn() },
    "@/lib/platform": { platformReady: async () => undefined, platformDb: () => database },
    "@/lib/db": { ready: async () => undefined, db: () => database },
    "@/lib/vendorKeys": { vendorKey: () => null },
    "@/lib/settings": { allSettings: async () => ({}) },
    "@/lib/storage": { presignedReadUrl: async () => "https://private.example/probe?signature=SECRET" },
    "@/lib/mail": { mailConfigured: () => false, mailFrom: () => null },
    "@/lib/mock": { engineMock: () => false },
    "@/lib/dispatch": { dispatchMode: () => "native" },
    "@/lib/dispatch-log": {
      recentDispatches: async (limit: number) => {
        if (options.dispatchLogDown) throw new Error("SECRET_DATABASE_URL");
        return [
          { id: "r2", eventId: "render-ws-gen_1", name: "render/requested", phase: "run", outcome: "finished-ok", status: null, durationMs: 1234, workspaceId: "workspace", createdAt: 2 },
          { id: "r1", eventId: "render-ws-gen_1", name: "render/requested", phase: "send", outcome: "sent", status: 202, durationMs: 40, workspaceId: "workspace", createdAt: 1 },
        ].slice(0, limit);
      },
    },
    "@vercel/blob": {
      put: async (key: string) => { writes.push(key); return { url: "https://private.example/" + key }; },
      del: async (url: string) => { deletes.push(url); if (options.cleanupFails) throw new Error("SECRET_TOKEN"); },
    },
  };
  const source = ts.transpileModule(readFileSync(path.resolve("app/api/health/route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { GET?: (req: Request) => Promise<Response> } = {};
  vm.runInNewContext(source, { exports, require: (name: string) => mocks[name] ?? nativeRequire(name),
    process: { env: { NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: "SECRET" } }, URL, Response, Buffer, Uint8Array, AbortSignal,
    fetch: async () => new Response(new Uint8Array([48, 49]), { status: options.rangeStatus ?? 206, headers: { "Content-Range": "bytes 0-1/10", "Accept-Ranges": "bytes" } }),
  });
  return { get: exports.GET!, writes, deletes };
}

test("public health is read-only and explicitly does not claim storage verification", async () => {
  const f = healthFixture();
  const response = await f.get(new Request("https://example.test/api/health"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, database: "ok", storageVerified: false, dispatch: { mode: "native" } });
  expect(f.writes).toHaveLength(0);
});

test("the dispatch timeline is in the signed-in briefing only, and its failure is coarse", async () => {
  const anonymous = await (await healthFixture().get(new Request("https://example.test/api/health"))).json();
  expect(anonymous.dispatch).toEqual({ mode: "native" });
  const full = await (await healthFixture({ signedIn: true }).get(new Request("https://example.test/api/health"))).json();
  expect(full.dispatch.mode).toBe("native");
  expect(full.dispatch.recent).toHaveLength(2);
  expect(full.dispatch.recent[0]).toMatchObject({ phase: "run", outcome: "finished-ok", eventId: "render-ws-gen_1" });
  expect(full.dispatch.recent[1]).toMatchObject({ phase: "send", outcome: "sent", status: 202 });
  const down = healthFixture({ signedIn: true, dispatchLogDown: true });
  const response = await down.get(new Request("https://example.test/api/health"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.dispatch).toEqual({ mode: "native", recent: null });
  expect(JSON.stringify(body)).not.toContain("SECRET");
});

test("workspace membership cannot authorize shared storage probes", async () => {
  const f = healthFixture({ signedIn: true });
  expect((await f.get(new Request("https://example.test/api/health?deep=1"))).status).toBe(403);
  expect(f.writes).toHaveLength(0);
});

test("private range and cleanup failures are unhealthy and disclose no secret-bearing errors", async () => {
  for (const failure of [{ rangeStatus: 200 }, { cleanupFails: true }]) {
    const f = healthFixture({ signedIn: true, admin: true, ...failure });
    const response = await f.get(new Request("https://example.test/api/health?deep=1"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
    expect(f.deletes).toHaveLength(1);
  }
});

test("deep probes use unique object names and a broken database returns a coarse 503", async () => {
  const healthy = healthFixture({ signedIn: true, admin: true });
  for (let index = 0; index < 2; index++) expect((await healthy.get(new Request("https://example.test/api/health?deep=1"))).status).toBe(200);
  expect(new Set(healthy.writes).size).toBe(2);
  expect(healthy.deletes).toHaveLength(2);
  const response = await healthFixture({ databaseDown: true }).get(new Request("https://example.test/api/health"));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("SECRET");
});
