import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { PEOPLE_ONLY } from "../../lib/security/people-only";

/**
 * Approving a take is people-only (owner, 14 Oct 2026; CLAUDE.md rules 11 and 14; docs/plans/step-0-data.md item 3). PATCH /api/jobs/:id with
 * { reviewState: "approved" }, or clearing an approval, is refused with 403 and PEOPLE_ONLY for an API token (an MCP client is one), and for an agent
 * identity (agent:*), with nothing written; a person is allowed. Picking, sending back and clearing a pick stay open to them. The real route on a real
 * workspace database; nothing renders and nothing is billed.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-take-approval-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const WS: TenantWorkspace = {
  id: "ws_approval", name: "ws_approval", slug: "ws_approval", legacy: false, dbUrl: `file:${path.join(dir, "ws_approval.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
  ownerId: "u_admin", createdAt: 0, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
};
type Who = { id: string; token?: { id: string; name: string; scope: string } };
const WHO: Record<string, Who> = {
  person: { id: "u_admin" },
  renderToken: { id: "u_admin", token: { id: "tok1", name: "t", scope: "render" } },
  mcpToken: { id: "u_admin", token: { id: "tok2", name: "Claude over MCP", scope: "prepare" } },
  agent: { id: "agent:run-1" },
};

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

async function setup() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const records = await import("../../lib/workbench/records");
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  const state = { who: WHO.person };
  const auth = {
    withTenant: (handler: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => tenant.runInTenant(WS, () => handler(...a)),
    requireUser: async () => ({ user: { id: state.who.id, name: state.who.id, role: "admin", owner: false }, ...(state.who.token ? { token: state.who.token } : {}) }),
  };
  const jobs = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" }, "@/lib/workAccess": await import("../../lib/workAccess"),
    "@/lib/draftProject": { mayReachProject: async () => true, productionReachable: async () => true, mayReadTake: async () => true, NO_SUCH_PROJECT: "\u0000unknown" },
    "@/lib/workbench/records": records, "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
    "@/lib/mediaBindings": await import("../../lib/mediaBindings"), "@/lib/mediaDeletion": await import("../../lib/mediaDeletion"),
    "@/lib/jobs": await import("../../lib/jobs"), "@/lib/shots": await import("../../lib/shots"), "@/lib/held": await import("../../lib/held"),
    "next/server": { NextResponse, after: () => {} }, "@/lib/recovery": { reserveRecoveryContinuation: async (_n: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async () => {} }, "@/lib/usageLedger": {},
  });
  const patch = async (id: string, body: unknown) => {
    const res = await jobs.PATCH(new Request("https://studio.test/api/jobs/x", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${WS.id}-${state.who.id}` }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
  };
  const row = async (id: string) => (await tenant.runInTenant(WS, async () => (await database.db().execute({ sql: "SELECT title, review_state, review_by, picked_by, approved_by, approved_at FROM generations WHERE id=?", args: [id] })).rows[0]));
  return { as: (name: string) => { state.who = WHO[name]; }, patch, row, tenant, database };
}

async function seed(api: Awaited<ReturnType<typeof setup>>, ids: string[]) {
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    await api.database.db().batch([
      { sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('u_admin','a@example.invalid','Admin','!','admin',0,0)", args: [] },
      ...ids.map((id) => ({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,stored_url) VALUES(?,'m','p','{}','succeeded',1,1,'image','Original',0,'u_admin',?)`, args: [id, `/api/media/${id}`] })),
    ], "write");
  });
}

test("a person approves and clears an approval; an API token, an MCP client and an agent are refused, with nothing written", async () => {
  const api = await setup();
  await seed(api, ["t1", "t2"]);

  api.as("person");
  expect((await api.patch("t1", { reviewState: "approved" })).status).toBe(200);
  expect(await api.row("t1")).toMatchObject({ review_state: "approved", approved_by: "u_admin" });

  for (const who of ["renderToken", "mcpToken", "agent"]) {
    api.as(who);
    /* Approving: refused, and the rest of the same request does not land either. */
    const approve = await api.patch("t2", { reviewState: "approved", title: "Renamed by a machine" });
    expect([who, approve.status, approve.body.error]).toEqual([who, 403, PEOPLE_ONLY]);
    expect(await api.row("t2"), who).toMatchObject({ title: "Original", review_state: "", approved_by: null, approved_at: null });
    /* Taking a person's sign-off back: refused, and the take is still approved. */
    const clear = await api.patch("t1", { reviewState: "", title: "Renamed by a machine" });
    expect([who, clear.status, clear.body.error]).toEqual([who, 403, PEOPLE_ONLY]);
    expect(await api.row("t1"), who).toMatchObject({ title: "Original", review_state: "approved", approved_by: "u_admin" });
    /* A take that is not there answers an approval alike (nothing says whether it exists). */
    const unknown = await api.patch("t-not-there", { reviewState: "approved" });
    expect([who, unknown.status, unknown.body.error]).toEqual([who, 403, PEOPLE_ONLY]);
  }
});

test("picking, sending back and clearing a pick stay open to a token and an agent", async () => {
  const api = await setup();
  await seed(api, ["t3"]);
  for (const who of ["renderToken", "mcpToken", "agent"]) {
    api.as(who);
    expect((await api.patch("t3", { reviewState: "picked" })).status, who).toBe(200);
    expect(await api.row("t3"), who).toMatchObject({ review_state: "picked" });
    expect((await api.patch("t3", { reviewState: "changes" })).status, who).toBe(200);
    expect((await api.patch("t3", { reviewState: "picked" })).status, who).toBe(200);
    expect((await api.patch("t3", { reviewState: "" })).status, who).toBe(200);
    expect(await api.row("t3"), who).toMatchObject({ review_state: "" });
  }
});
