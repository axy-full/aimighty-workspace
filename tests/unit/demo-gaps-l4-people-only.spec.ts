import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/*
 * People-only (CLAUDE.md rule 14; owner, 6 Oct): approving spend, setting limits and the budget, and topping up are a
 * person's. Atomik (`agent:<run>`) and outside agents on an API or MCP token prepare only. Each money route these gap
 * screens use runs here through the real withTenant and auth, as a signed-in admin and as a render-scoped token that
 * an ADMIN made (the strongest token there is): the person gets through, the token is refused, and nothing changes.
 * Atomik's own identity never holds a session; where a function takes an actor id, `agent:` is refused there too.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-l4-people-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const WS: TenantWorkspace = {
  id: "ws_lfour", name: "ws_lfour", slug: "ws_lfour", legacy: false,
  dbUrl: `file:${path.join(dir, "ws_lfour.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "boss", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};
const SCOPE = `particl-active-${WS.id}-boss`;
const RAW = `pk_lfour_${"7".repeat(48)}`;

/** A route file (or lib/auth.ts) compiled as CommonJS, with chosen dependencies replaced. */
function load<T>(file: string, deps: Record<string, unknown>): T {
  const filename = path.resolve(file), req = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(deps, name)) return deps[name];
      if (name.startsWith("@/")) return req(path.resolve(name.slice(2)));
      return req(name);
    },
    mod, mod.exports,
  );
  return mod.exports as T;
}

let mode: "session" | "token" = "session";
async function harness() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => (mode === "session" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(mode === "token" ? { authorization: `Bearer ${RAW}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => ({ account: { id: "boss", name: "Studio admin", email: "boss@example.invalid", mfa_enabled: 1 }, workspaceId: WS.id }),
      workspacesFor: async () => [{ workspace: WS, role: "admin" }],
      getWorkspace: async (id: string) => (id === WS.id ? WS : null),
      legacyWorkspace: async () => null,
      platformReady: async () => {},
      /* The membership the token's user holds: an admin. */
      platformDb: () => ({ execute: async () => ({ rows: [{ role: "admin" }] }) }),
    },
  });
  const deps = { "@/lib/auth": auth, "@/lib/tenant": tenant, "@/lib/db": database, "@/lib/workbench/request-scope": scope };
  return {
    auth,
    settings: load<typeof import("../../app/api/settings/route")>("app/api/settings/route.ts", deps),
    project: load<typeof import("../../app/api/projects/[id]/route")>("app/api/projects/[id]/route.ts", deps),
    topups: load<typeof import("../../app/api/workspaces/topups/route")>("app/api/workspaces/topups/route.ts", deps),
    ask: load<typeof import("../../app/api/workbench/ask-admin/route")>("app/api/workbench/ask-admin/route.ts", deps),
    canvas: load<typeof import("../../app/api/workbench/team-canvas/route")>("app/api/workbench/team-canvas/route.ts", deps),
  };
}

const req = (url: string, method: string, body?: unknown) => new Request(`http://localhost${url}`, {
  method, headers: { "Content-Type": "application/json", ...(mode === "session" ? { "X-Workbench-Scope": SCOPE } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function seed() {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { tokenHash } = await import("../../lib/auth");
  await runInTenant(WS, async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('boss','boss@example.invalid','Studio admin','x','admin',0)",
      "INSERT INTO projects(id,name,created_at) VALUES('prod-l4','A 15-second film',0)",
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_l4',?,'outside agent','boss','render',0)", args: [tokenHash(RAW)] },
    ], "write");
  });
}
const read = async <T,>(sql: string): Promise<T[]> => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  return runInTenant(WS, async () => (await db().execute(sql)).rows as unknown as T[]);
};

test("setting the budget per production and the per-shot cap: a signed-in admin can; an admin's own render token cannot, and nothing changes", async () => {
  await seed();
  const api = await harness();
  mode = "token";
  const byToken = await api.settings.PATCH(req("/api/settings", "PATCH", { productionBudgetCredits: "400", approvalRule: "cap", shotCapCredits: "1000000" }), undefined as never);
  expect(byToken.status).toBe(403);
  expect(await read("SELECT key FROM settings WHERE key IN ('productionBudgetCredits','shotCapCredits','approvalRule')")).toEqual([]);

  mode = "session";
  const byPerson = await api.settings.PATCH(req("/api/settings", "PATCH", { productionBudgetCredits: "400", approvalRule: "cap", shotCapCredits: "50" }), undefined as never);
  expect(byPerson.status, await byPerson.clone().text()).toBe(200);
  const rows = await read<{ key: string; value: string; updated_by: string }>("SELECT key,value,updated_by FROM settings WHERE key IN ('productionBudgetCredits','shotCapCredits','approvalRule') ORDER BY key");
  expect(rows.map((r) => [r.key, r.value])).toEqual([["approvalRule", "cap"], ["productionBudgetCredits", "400"], ["shotCapCredits", "50"]]);
  /* Every change is logged with who made it: a person. */
  expect(new Set(rows.map((r) => r.updated_by))).toEqual(new Set(["boss"]));
  /* Nonsense is refused before anything is written. */
  const bad = await api.settings.PATCH(req("/api/settings", "PATCH", { productionBudgetCredits: "0" }), undefined as never);
  expect(bad.status).toBe(400);
});

test("a production's own cap and its unlock: a signed-in admin can; a token cannot (it used to pass, as requireUser let tokens through)", async () => {
  const api = await harness();
  const ctx = { params: Promise.resolve({ id: "prod-l4" }) };
  mode = "token";
  for (const body of [{ capCredits: 999999 }, { capCredits: null }, { capUnlocked: true }]) {
    const r = await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", body), ctx as never);
    expect(r.status, JSON.stringify(body)).toBe(403);
  }
  expect(await read<{ cap_credits: number | null; cap_unlocked: number }>("SELECT cap_credits,cap_unlocked FROM projects WHERE id='prod-l4'")).toEqual([{ cap_credits: null, cap_unlocked: 0 }]);
  mode = "session";
  const ok = await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: 400 }), ctx as never);
  expect(ok.status).toBe(200);
  expect((await read<{ cap_credits: number }>("SELECT cap_credits FROM projects WHERE id='prod-l4'"))[0].cap_credits).toBe(400);
  await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: null }), ctx as never);
});

test("topping up: a token neither asks for credits nor withdraws a request, and its read says it can't", async () => {
  const api = await harness();
  mode = "token";
  const asked = await api.topups.POST(req("/api/workspaces/topups", "POST", { packId: "starter" }), undefined as never);
  expect(asked.status).toBe(403);
  expect((await asked.json()).error).toContain("API tokens cannot top up");
  const withdrawn = await api.topups.DELETE(req("/api/workspaces/topups?id=anything", "DELETE"), undefined as never);
  expect(withdrawn.status).toBe(403);
  const listed = await api.topups.GET(req("/api/workspaces/topups", "GET"), undefined as never);
  expect(listed.status).toBe(200);
  expect((await listed.json()).canRequest).toBe(false);
});

test("Ask an admin and every approval on the board's plan take a person's session: a token is refused before anything is read", async () => {
  const api = await harness();
  mode = "token";
  const asked = await api.ask.POST(req("/api/workbench/ask-admin", "POST", { about: "rules" }), undefined as never);
  expect(asked.status).toBe(403);
  for (const action of [
    { action: "agent.approve", runId: "rar_x", fingerprint: "f".repeat(64) },
    { action: "agent.render", runId: "rar_x", seq: 3, fingerprint: "f".repeat(64) },
    { action: "agent.limit", runId: "rar_x", limit: 500 },
    { action: "agent.stop", runId: "rar_x" },
  ]) {
    const r = await api.canvas.POST(req("/api/workbench/team-canvas", "POST", { productionId: "prod-l4", ...action }), undefined as never);
    expect(r.status, action.action).toBe(403);
    expect((await r.json()).error).toContain("signed-in browser session");
  }
});

test("Ask an admin: Atomik's identity is refused; an admin is told they can do it; a member's ask goes to the owner and admins and changes nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const lib = await import("../../lib/control-room/ask-admin");
  const told: { ids: string[]; title: string; body: string; url: string }[] = [];
  const deps = { admins: async () => [{ id: "boss" }, { id: "second" }], tell: async (ids: string[], p: { title: string; body: string; url: string }) => { told.push({ ids, ...p }); } };
  await runInTenant(WS, async () => {
    for (const id of ["agent:rar_123", "auto", "server", ""]) {
      await expect(lib.askAdmin({ id, name: "Atomik", admin: false }, { about: "rules" }, deps)).rejects.toMatchObject({ status: 403, message: lib.ASK_NOT_A_PERSON });
    }
    await expect(lib.askAdmin({ id: "boss", name: "Studio admin", admin: true }, { about: "rules" }, deps)).rejects.toMatchObject({ status: 409 });
    const before = await read("SELECT key,value FROM settings ORDER BY key");
    const r = await lib.askAdmin({ id: "mem", name: "Studio member", admin: false }, { about: "rules" }, deps);
    expect(r).toEqual({ asked: 2, line: "Asked. The owner and admins were told; nothing was spent." });
    expect(told).toEqual([{ ids: ["boss", "second"], title: "Studio member asks an admin", body: "About the budget per production or the per-shot cap, in Settings › Spending rules.", url: "/suites?view=workspace&ws=rules" }]);
    expect(await read("SELECT key,value FROM settings ORDER BY key")).toEqual(before);
    /* A step that is not on a plan here is not asked about. */
    await expect(lib.askAdmin({ id: "mem", name: "Studio member", admin: false }, { about: "step", productionId: "prod-l4", runId: "rar_none", seq: 1 }, deps)).rejects.toMatchObject({ status: 404 });
  });
  expect(lib.isPersonId("boss")).toBe(true);
  expect(lib.isPersonId("agent:rar_1")).toBe(false);
});

test("the budget per production: a production with no cap of its own follows it; its own cap wins; the gate's verdict and the paused line use it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const caps = await import("../../lib/caps");
  await runInTenant(WS, async () => {
    const { db } = await import("../../lib/db");
    const { setSetting } = await import("../../lib/settings");
    await setSetting("productionBudgetCredits", "400", "boss");
    expect(await caps.workspaceBudget()).toBe(400);
    expect(await caps.projectCap("prod-l4")).toMatchObject({ unit: "cr", cap: 400, from: "workspace" });
    await db().execute("UPDATE projects SET cap_credits=150 WHERE id='prod-l4'");
    expect(await caps.projectCap("prod-l4")).toMatchObject({ cap: 150, from: "production" });
    await db().execute("UPDATE projects SET cap_credits=NULL WHERE id='prod-l4'");
    /* Nothing spent yet: a 7 cr render is far from the 320 cr pause. */
    expect(await caps.budgetAsk("prod-l4", 7)).toBeNull();
    expect(await caps.budgetAsk("prod-l4", 320)).toMatchObject({ pause: { pauseAt: 320, reached: true }, line: "Paused at 80 % of the budget: 0 of 400 cr used. Continue or stop." });
    /* Unlocked by an admin past its cap: no pause. */
    await db().execute("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
    expect(await caps.budgetAsk("prod-l4", 320)).toBeNull();
    await db().execute("UPDATE projects SET cap_unlocked=0 WHERE id='prod-l4'");
    /* Cleared: no budget, no cap, no pause. */
    await setSetting("productionBudgetCredits", "", "boss");
    expect(await caps.projectCap("prod-l4")).toMatchObject({ cap: null, from: null });
    expect(await caps.budgetAsk("prod-l4", 99999)).toBeNull();
  });
});
