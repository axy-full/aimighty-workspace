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

test("a review that is not a word cannot pass the gate or be written as something else: refused whole, from a person, a token and an agent, with nothing written", async () => {
  const api = await setup();
  await seed(api, ["t4"]);
  for (const who of ["person", "renderToken", "mcpToken", "agent"]) {
    api.as(who);
    for (const bad of [["approved"], ["picked"], 1, true, { state: "approved" }, [""]]) {
      const res = await api.patch("t4", { reviewState: bad, title: "Renamed" });
      expect([who, JSON.stringify(bad), res.status]).toEqual([who, JSON.stringify(bad), 400]);
      expect(await api.row("t4"), `${who} ${JSON.stringify(bad)}`).toMatchObject({ title: "Original", review_state: "", approved_by: null, picked_by: null });
    }
  }
});

test("a token or an agent cannot end a person's sign-off any way: clear, pick over it or send it back; a person can", async () => {
  const api = await setup();
  await seed(api, ["t5"]);
  api.as("person");
  expect((await api.patch("t5", { reviewState: "approved" })).status).toBe(200);
  for (const who of ["renderToken", "mcpToken", "agent"]) {
    api.as(who);
    for (const state of ["", "picked", "changes", null]) {
      const res = await api.patch("t5", { reviewState: state });
      expect([who, state, res.status, res.body.error]).toEqual([who, state, 403, PEOPLE_ONLY]);
      expect(await api.row("t5"), `${who} ${state}`).toMatchObject({ review_state: "approved", approved_by: "u_admin" });
    }
  }
  api.as("person");
  expect((await api.patch("t5", { reviewState: "changes" })).status).toBe(200);
  expect(await api.row("t5")).toMatchObject({ review_state: "changes" });
});

test("the attribute swap un-approves takes only for a person: a token or an agent is refused before the version moves; a swap that returns nothing is open", async () => {
  const api = await setup();
  const calls: string[] = [];
  const impact = (approved: boolean) => ({
    shots: [{ shotId: "s_attr", approved }],
    choices: ["none", "approved", "all"].map((key) => ({ key, verdict: { allow: true, line: "" }, quote: { totalCredits: 0 }, shots: [] })),
  });
  let current = impact(true);
  let who = WHO.person;
  const route = load<typeof import("../../app/api/rig/attributes/[id]/current/route")>("app/api/rig/attributes/[id]/current/route.ts", {
    "@/lib/auth": {
      withTenant: (handler: (...a: unknown[]) => Promise<unknown>) => (...a: unknown[]) => api.tenant.runInTenant(WS, () => handler(...a)),
      requireRender: async () => ({ user: { id: who.id, name: who.id, role: "admin" }, ...(who.token ? { token: who.token } : {}) }),
    },
    "@/lib/db": api.database, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
    "@/lib/impact": { impactOf: async () => current },
    "@/lib/elements": { setCurrentVersion: async (_a: string, v: string) => { calls.push(v); } },
  });
  await api.tenant.runInTenant(WS, async () => {
    await api.database.ready();
    await api.database.db().batch([
      { sql: "INSERT INTO projects(id,name,created_at) VALUES('p','Board',0)", args: [] },
      { sql: "INSERT INTO elements(id,project_id,kind,name,created_at,updated_at) VALUES('el_a','p','character','Lead',1,1)", args: [] },
      { sql: "INSERT INTO element_attributes(id,element_id,kind,current_id,created_at,updated_at) VALUES('at_a','el_a','face','v_old',1,1)", args: [] },
      { sql: "INSERT INTO attribute_versions(id,attribute_id,element_id,status,created_at) VALUES('v_new','at_a','el_a','ready',1)", args: [] },
      { sql: "INSERT INTO shots(id,project_id,code,title,status,position,created_at,updated_at) VALUES('s_attr','p','010','S','open',0,0,0)", args: [] },
      { sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,shot_id,review_state,approved_by) VALUES('t_attr','m','p','{}','succeeded',1,1,'video','T',0,'u_admin','s_attr','approved','Admin')", args: [] },
    ], "write");
  });
  const post = (body: unknown) => route.POST(new Request("https://studio.test/api/rig/attributes/at_a/current", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "at_a" }) });
  const state = async () => String((await api.row("t_attr"))?.review_state);
  for (const name of ["renderToken", "mcpToken", "agent"]) {
    who = WHO[name];
    for (const choice of ["approved", "all"]) {
      const res = await post({ versionId: "v_new", choice });
      expect([name, choice, res.status, (await res.json()).error]).toEqual([name, choice, 403, PEOPLE_ONLY]);
    }
    expect(calls, name).toEqual([]);
    expect(await state(), name).toBe("approved");
    /* Nothing approved is reached, or the choice returns nothing: nothing to undo, open as before. */
    current = impact(false);
    expect((await post({ versionId: "v_new", choice: "approved" })).status, `${name} none approved`).toBe(200);
    current = impact(true);
    expect((await post({ versionId: "v_new", choice: "none" })).status, `${name} choice none`).toBe(200);
    calls.length = 0;
  }
  who = WHO.person;
  const done = await post({ versionId: "v_new", choice: "approved" });
  expect(done.status, JSON.stringify(await done.clone().json())).toBe(200);
  expect(calls).toEqual(["v_new"]);
  expect(await state()).toBe("");
});
