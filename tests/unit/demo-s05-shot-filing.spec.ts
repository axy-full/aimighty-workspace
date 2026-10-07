import { test, expect } from "@playwright/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Filing a take on a shot, moving it, and unfiling it: PATCH /api/jobs/:id { shotId } (app/api/jobs/[id]/route.ts).
 * `generations.version` is NOT NULL (lib/db.ts), so the route must never write NULL into it: unfiling (the Undo of
 * a filing) and filing a sound both used to, and the database refused the write.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-shot-filing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

function workspace(id: string): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "member", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null,
    flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

async function seed(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    const take = (id: string, kind: string) => ({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title) VALUES(?,'fixture','A prompt','{}','succeeded',100,100,?,?)`,
      args: [id, kind, `Take ${id}`],
    });
    await db().batch([
      take("clip-1", "video"), take("clip-2", "video"), take("sound", "audio"),
      { sql: `INSERT INTO shots(id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at) VALUES('shot-a',NULL,'','A','','','open',0,'member',1,1)`, args: [] },
      { sql: `INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('member','member@example.invalid','Person member','!','member',0,0)`, args: [] },
    ]);
  });
}

async function routes(initial: TenantWorkspace) {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const jobs = await import("../../lib/jobs");
  const shots = await import("../../lib/shots");
  /* The route's own NextResponse, required the way the route requires it. */
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  let selected = initial;
  const afters: (() => Promise<unknown>)[] = [];
  const notified: { kind: string; ids: string[]; payload: { title: string; body: string; url?: string } }[] = [];
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => ({ value: "fixture-session" }) }),
      headers: async () => new Headers(),
    },
    "./platform": {
      sessionLookup: async () => ({
        account: { id: "member", name: "Studio member", email: "member@example.invalid", mfa_enabled: 1 },
        workspaceId: selected.id,
      }),
      workspacesFor: async () => [{ workspace: selected, role: "member" }],
    },
  });
  const route = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/tenant": tenant, "@/lib/db": database,
    "@/lib/workbench/request-scope": scope,
    "@/lib/jobs": { getGeneration: jobs.getGeneration, syncGeneration: async (value: unknown) => value },
    /* Next runs an `after` task in the request's own context (its workspace), once the response is sent. */
    "next/server": { NextResponse, after: (task: () => Promise<unknown>) => { afters.push(AsyncLocalStorage.bind(task)); } },
    "@/lib/recovery": { reserveRecoveryContinuation: async (_name: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async (kind: string, ids: string[], payload: { title: string; body: string; url?: string }) => { notified.push({ kind, ids: [...ids].sort(), payload }); } },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
    "@/lib/workbench/records": {}, "@/lib/mediaBindings": {}, "@/lib/mediaDeletion": {}, "@/lib/shots": shots, "@/lib/held": {},
  });
  const patch = (id: string, body: unknown, headers: Record<string, string> = { "X-Workbench-Scope": `particl-active-${selected.id}-member` }) =>
    route.PATCH(new Request(`https://studio.test/api/jobs/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const row = async (ws: TenantWorkspace, id: string) => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    return runInTenant(ws, async () => (await db().execute({ sql: "SELECT shot_id, version, kind FROM generations WHERE id=?", args: [id] })).rows[0]);
  };
  return { patch, row, afters, notified, switch: (ws: TenantWorkspace) => { selected = ws; } };
}

test("filing numbers takes per shot; unfiling and filing a sound write no NULL version", async () => {
  const ws = workspace("shot-filing");
  await seed(ws);
  const api = await routes(ws);

  expect((await api.patch("clip-1", { shotId: "shot-a" })).status).toBe(200);
  expect((await api.patch("clip-2", { shotId: "shot-a" })).status).toBe(200);
  expect(await api.row(ws, "clip-1")).toMatchObject({ shot_id: "shot-a", version: 1 });
  expect(await api.row(ws, "clip-2")).toMatchObject({ shot_id: "shot-a", version: 2 });

  /* A sound filed on a shot takes no new number: it keeps the one it has (here the default). */
  const sound = await api.patch("sound", { shotId: "shot-a" });
  expect(sound.status).toBe(200);
  expect(await api.row(ws, "sound")).toMatchObject({ shot_id: "shot-a", version: 1 });

  /* Unfiling (the Undo of a filing) leaves the take unfiled at the default an unfiled render carries. */
  const unfiled = await api.patch("clip-2", { shotId: null });
  expect(unfiled.status).toBe(200);
  expect(await api.row(ws, "clip-2")).toMatchObject({ shot_id: null, version: 1 });

  /* Filed again, it takes the shot's next number. */
  expect((await api.patch("clip-2", { shotId: "shot-a" })).status).toBe(200);
  expect(await api.row(ws, "clip-2")).toMatchObject({ shot_id: "shot-a", version: 2 });
});
