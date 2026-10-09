import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * GET /api/control-room/approvals through the real withTenant and
 * requireSession: a signed-in person reads their own workspace's queue and
 * nobody else's, a signed-out caller is refused, and an API token is refused
 * even with render scope (only a person approves, so only a person reads the
 * list they approve from).
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-control-room-route-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
/* Fixture credit rows (grants, meter) are stamped 0, as tests/helpers/fundFixtureWorkspace.ts does: a row stamped now would
   make the shared platform database's ledger seed read as the old price and pause paid work for later specs (lib/ledgerUnit.ts). */

function workspace(id: string): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "member", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
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

async function seed(ws: TenantWorkspace, heldId: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)", args: [`grant_${ws.id}_${Date.now().toString(36)}`, ws.id, 0] });
  await runInTenant(ws, async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Studio member','x',0)",
      {
        sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at)
              VALUES(?,'video','byteplus','dreamina-seedance-2-0-260128','A quiet street',?,'held','member',?,?)`,
        args: [heldId, JSON.stringify({ duration: 5, held: { estUsd: 1, needs: 15, at: 1, why: "credits" } }), Date.now(), Date.now()],
      },
    ], "write");
  });
}

async function harness() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const server = await import("../../lib/control-room/approvals.server");
  let selected: TenantWorkspace | null = null;
  let mode: "session" | "token" | "none" = "session";
  let bearer = "";
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => (mode === "session" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(mode === "token" ? { authorization: `Bearer ${bearer}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => ({
        account: { id: "member", name: "Studio member", email: "member@example.invalid", mfa_enabled: 1 },
        workspaceId: selected!.id,
      }),
      workspacesFor: async () => [{ workspace: selected, role: "member" }],
      getWorkspace: async (id: string) => (selected && selected.id === id ? selected : null),
      legacyWorkspace: async () => null,
      platformReady: async () => {},
      platformDb: () => ({ execute: async () => ({ rows: [{ role: "member" }] }) }),
    },
  });
  const route = load<typeof import("../../app/api/control-room/approvals/route")>("app/api/control-room/approvals/route.ts", {
    "@/lib/auth": auth,
    "@/lib/control-room/approvals.server": server,
  });
  return {
    get: () => route.GET(new Request("http://localhost/api/control-room/approvals"), undefined as never),
    as: (ws: TenantWorkspace, how: "session" | "token" | "none", token = "") => { selected = ws; mode = how; bearer = token; },
    tokenHash: auth.tokenHash,
  };
}

const A = workspace("ws_routea"), B = workspace("ws_routeb");

test("a person reads their own workspace's queue, never another's; a signed-out caller and an API token are refused", async () => {
  await seed(A, "gen_only_a");
  await seed(B, "gen_only_b");
  const api = await harness();

  api.as(A, "session");
  const a = await api.get();
  expect(a.status).toBe(200);
  const fromA = await a.json();
  expect(fromA.items.map((i: { id: string }) => i.id)).toEqual(["held:gen_only_a"]);
  expect(JSON.stringify(fromA)).not.toContain("gen_only_b");
  expect(a.headers.get("cache-control")).toContain("no-store");

  api.as(B, "session");
  const fromB = await (await api.get()).json();
  expect(fromB.items.map((i: { id: string }) => i.id)).toEqual(["held:gen_only_b"]);

  api.as(A, "none");
  expect((await api.get()).status).toBe(401);

  /* A render-scoped token of this very workspace, valid for its member: still refused. */
  const raw = `pk_routea_${"9".repeat(48)}`;
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(A, () => db().execute({
    sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_render',?,'agent','member','render',0)",
    args: [api.tokenHash(raw)],
  }));
  api.as(A, "token", raw);
  const byToken = await api.get();
  expect(byToken.status).toBe(403);
  expect(JSON.stringify(await byToken.json())).not.toContain("gen_only_a");
});
