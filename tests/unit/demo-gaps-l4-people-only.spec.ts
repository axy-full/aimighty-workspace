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
const scopeOf = () => `particl-active-${WS.id}-${mode === "member" ? "mem" : "boss"}`;
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

let mode: "session" | "member" | "token" = "session";
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
      cookies: async () => ({ get: () => (mode !== "token" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(mode === "token" ? { authorization: `Bearer ${RAW}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => (mode === "member"
        ? { account: { id: "mem", name: "Studio member", email: "mem@example.invalid", mfa_enabled: 1 }, workspaceId: WS.id }
        : { account: { id: "boss", name: "Studio admin", email: "boss@example.invalid", mfa_enabled: 1 }, workspaceId: WS.id }),
      workspacesFor: async () => [{ workspace: WS, role: mode === "member" ? "member" : "admin" }],
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
    projects: load<typeof import("../../app/api/projects/route")>("app/api/projects/route.ts", deps),
    production: load<typeof import("../../app/api/productions/[id]/route")>("app/api/productions/[id]/route.ts", deps),
    release: load<typeof import("../../app/api/jobs/[id]/release/route")>("app/api/jobs/[id]/release/route.ts", deps),
    budget: load<typeof import("../../app/api/workbench/budget/route")>("app/api/workbench/budget/route.ts", deps),
  };
}

const req = (url: string, method: string, body?: unknown) => new Request(`http://localhost${url}`, {
  method, headers: { "Content-Type": "application/json", ...(mode !== "token" ? { "X-Workbench-Scope": scopeOf() } : {}) },
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
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('mem','mem@example.invalid','Studio member','x','member',0)",
      "INSERT INTO productions(id,name,client,status,created_at) VALUES('container-l4','A container','','active',0)",
      "INSERT INTO projects(id,name,created_at,production_id) VALUES('prod-l4','A 15-second film',0,'container-l4')",
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_l4',?,'outside agent','boss','render',0)", args: [tokenHash(RAW)] },
    ], "write");
  });
}
const exec = async (sql: string) => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(WS, async () => { await db().execute(sql); });
};
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
  /* The setting keeps who changed it last: a person. */
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
    /* Unlocked by an admin: past its cap it goes on; below the cap the ask still stands. */
    await db().execute("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
    expect(await caps.budgetAsk("prod-l4", 320)).not.toBeNull();
    await db().execute("UPDATE projects SET cap_unlocked=0 WHERE id='prod-l4'");
    /* Cleared: no budget, no cap, no pause. */
    await setSetting("productionBudgetCredits", "", "boss");
    expect(await caps.projectCap("prod-l4")).toMatchObject({ cap: null, from: null });
    expect(await caps.budgetAsk("prod-l4", 99999)).toBeNull();
  });
});

/* ── Review of #556: the holes its probes found, now closed (P2, P3, P5, P6) ── */

test("a container production's cap (PATCH /api/productions/[id]): an admin can; a member and an admin's token cannot (P2)", async () => {
  const api = await harness();
  const ctx = { params: Promise.resolve({ id: "container-l4" }) };
  mode = "token";
  expect((await api.production.PATCH(req("/api/productions/container-l4", "PATCH", { capCredits: 123456 }), ctx as never)).status).toBe(403);
  mode = "member";
  expect((await api.production.PATCH(req("/api/productions/container-l4", "PATCH", { capUsd: 7 }), ctx as never)).status).toBe(403);
  expect(await read("SELECT cap_credits,cap_usd FROM productions WHERE id='container-l4'")).toEqual([{ cap_credits: null, cap_usd: null }]);
  /* A member may still rename it: only the cap is an admin's. */
  expect((await api.production.PATCH(req("/api/productions/container-l4", "PATCH", { name: "Renamed" }), ctx as never)).status).toBe(200);
  mode = "session";
  expect((await api.production.PATCH(req("/api/productions/container-l4", "PATCH", { capCredits: 500 }), ctx as never)).status).toBe(200);
  expect(await read("SELECT cap_credits FROM productions WHERE id='container-l4'")).toEqual([{ cap_credits: 500 }]);
});

test("releasing a held take at a price is a person's: an admin's render token is refused before anything is read (P3)", async () => {
  const api = await harness();
  mode = "token";
  const r = await api.release.POST(req("/api/jobs/gen_none/release", "POST", { credits: 5 }), { params: Promise.resolve({ id: "gen_none" }) } as never);
  expect(r.status).toBe(403);
  expect((await r.json()).error).toContain("API tokens cannot release it");
  /* A person gets past auth to the lookup. */
  mode = "session";
  expect((await api.release.POST(req("/api/jobs/gen_none/release", "POST", { credits: 5 }), { params: Promise.resolve({ id: "gen_none" }) } as never)).status).toBe(404);
});

test("one cap everywhere: with a workspace budget, the projects list and the project read show the cap the gate enforces, whose it is, and Unlock where it can refuse (P5)", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const caps = await import("../../lib/caps");
  const words = await import("../../components/graphite/settings/rules/spending-words");
  const api = await harness();
  await runInTenant(WS, () => setSetting("productionBudgetCredits", "400", "boss"));
  mode = "session";
  const gate = await runInTenant(WS, () => caps.projectCap("prod-l4"));
  const list = await (await api.projects.GET(req("/api/projects", "GET"), undefined as never)).json() as { projects: { id: string; capCredits: number | null; capFrom: string | null; ownCapCredits: number | null }[] };
  const row = list.projects.find((p) => p.id === "prod-l4")!;
  const one = await (await api.project.GET(req("/api/projects/prod-l4", "GET"), { params: Promise.resolve({ id: "prod-l4" }) } as never)).json() as { project: { capCredits: number | null; capFrom: string | null; ownCapCredits: number | null } };
  expect(gate).toMatchObject({ cap: 400, from: "workspace" });
  expect(row).toMatchObject({ capCredits: 400, capFrom: "workspace", ownCapCredits: null });
  expect(one.project).toMatchObject({ capCredits: 400, capFrom: "workspace", ownCapCredits: null });
  /* Settings › Each production says so, and offers Unlock once the gate can refuse. */
  expect(words.productionLine({ id: "prod-l4", name: "A", credits: 120, capCredits: 400, capFrom: "workspace" }, (n) => `${n} cr`).sub).toBe("280 cr left of the workspace budget");
  expect(words.atItsCap({ id: "prod-l4", name: "A", credits: 400, capCredits: 400, capFrom: "workspace" })).toBe(true);
  expect(words.atItsCap({ id: "prod-l4", name: "A", credits: 399, capCredits: 400, capFrom: "workspace" })).toBe(false);
  /* Its own cap wins, and says so. */
  await exec("UPDATE projects SET cap_credits=150 WHERE id='prod-l4'");
  const own = await (await api.project.GET(req("/api/projects/prod-l4", "GET"), { params: Promise.resolve({ id: "prod-l4" }) } as never)).json() as { project: { capCredits: number; capFrom: string; ownCapCredits: number } };
  expect(own.project).toMatchObject({ capCredits: 150, capFrom: "production", ownCapCredits: 150 });
  await exec("UPDATE projects SET cap_credits=NULL WHERE id='prod-l4'");
  await runInTenant(WS, () => setSetting("productionBudgetCredits", "", "boss"));
});

test("an unlock belongs to the cap it was given for: a new cap or a new budget re-locks it and re-arms the warning; a stale unlock never silences the 80 % ask (P6)", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const caps = await import("../../lib/caps");
  const api = await harness();
  const ctx = { params: Promise.resolve({ id: "prod-l4" }) };
  mode = "session";
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: 100 }), ctx as never)).status).toBe(200);
  /* Unlocked at the old cap (a direct write: the route's own Unlock is tied to the cap shown, demo-gaps-l4-budget-gate). */
  await exec("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
  await exec("UPDATE projects SET cap_warned_at=1 WHERE id='prod-l4'");
  /* A new cap: re-locked, the warning re-armed, and the ask at 800 of 1,000 cr stands. */
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: 1000 }), ctx as never)).status).toBe(200);
  expect(await read("SELECT cap_credits,cap_unlocked,cap_warned_at FROM projects WHERE id='prod-l4'")).toEqual([{ cap_credits: 1000, cap_unlocked: 0, cap_warned_at: null }]);
  expect(await runInTenant(WS, () => caps.budgetAsk("prod-l4", 900))).toMatchObject({ pause: { pauseAt: 800, reached: true } });
  /* Unlocked again below the cap: the ask still stands (an unlock lets a production past its cap, not past the ask). */
  await exec("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
  expect(await runInTenant(WS, () => caps.budgetAsk("prod-l4", 900))).not.toBeNull();
  /* Setting the same cap again changes nothing; clearing it re-locks. */
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: 1000 }), ctx as never)).status).toBe(200);
  expect(await read("SELECT cap_unlocked FROM projects WHERE id='prod-l4'")).toEqual([{ cap_unlocked: 1 }]);
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capCredits: null }), ctx as never)).status).toBe(200);
  expect(await read("SELECT cap_unlocked FROM projects WHERE id='prod-l4'")).toEqual([{ cap_unlocked: 0 }]);
  /* Following the workspace budget, unlocked: a new budget (through the settings route) re-locks it and re-arms the warning. */
  await exec("UPDATE projects SET cap_unlocked=1, cap_warned_at=1 WHERE id='prod-l4'");
  expect((await api.settings.PATCH(req("/api/settings", "PATCH", { productionBudgetCredits: "300" }), undefined as never)).status).toBe(200);
  expect(await read("SELECT cap_unlocked,cap_warned_at FROM projects WHERE id='prod-l4'")).toEqual([{ cap_unlocked: 0, cap_warned_at: null }]);
  /* The re-lock in Settings: an admin's, and a person's. */
  await exec("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
  mode = "token";
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capUnlocked: false }), ctx as never)).status).toBe(403);
  mode = "member";
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capUnlocked: false }), ctx as never)).status).toBe(403);
  mode = "session";
  expect((await api.project.PATCH(req("/api/projects/prod-l4", "PATCH", { capUnlocked: false }), ctx as never)).status).toBe(200);
  expect(await read("SELECT cap_unlocked FROM projects WHERE id='prod-l4'")).toEqual([{ cap_unlocked: 0 }]);
  expect((await api.settings.PATCH(req("/api/settings", "PATCH", { productionBudgetCredits: "" }), undefined as never)).status).toBe(200);
});

test("Ask an admin judges a step as the gate does (what the shot holds plus this render; a step paused for an admin is over), counts every ask, refused or not, once per person and step every ten minutes", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const { db } = await import("../../lib/db");
  const { billCreditsWith, marginFor } = await import("../../lib/creditTerms");
  const lib = await import("../../lib/control-room/ask-admin");
  const store = await import("../../lib/workbench/rig-agent-store");
  const SEEDANCE = "dreamina-seedance-2-5-260628";
  let now = 1_000_000_000;
  const told: string[][] = [];
  /* The real over-cap check (lib/control-room/ask-admin.ts overCap): no stub. */
  const deps = { admins: async () => [{ id: "boss" }], tell: async (ids: string[]) => { told.push(ids); }, now: () => now };
  await runInTenant(WS, async () => {
    await setSetting("approvalRule", "cap", "boss");
    await store.rigAgentReady();
    /* Shot A already holds one take; its credits are what the gate counts for it (lib/caps.ts spentBy). */
    const held = billCreditsWith(1, marginFor(SEEDANCE), 0.10);
    await db().batch([
      { sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,project_id,shot_id,cost_usd,created_by) VALUES('g_shot_a','" + SEEDANCE + "','a','{}','succeeded',0,0,'video','prod-l4','shot_a',1,'mem')", args: [] },
      { sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,plan,created_at,updated_at) VALUES('rar_ask','prod-l4','d','mem','req-ask','g','auto','needs_you',NULL,0,0)", args: [] },
      /* Step 1 the run paused for an admin at send time: over, whatever its own price. */
      { sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,pause,created_at,updated_at) VALUES('step_paused','rar_ask',1,'render','Shot 1','take','{}','paused',20,1,'admin',0,0)", args: [] },
      /* Step 2: priced at 20 cr for shot A. */
      { sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,admission,created_at,updated_at) VALUES('step_quoted','rar_ask',2,'render','Shot 2','take','{}','waiting',20,1,'{\"request\":{\"shotId\":\"shot_a\"}}',0,0)", args: [] },
    ], "write");
    const me = { id: "mem", name: "Studio member", admin: false };
    const step = (seq: number) => ({ about: "step" as const, productionId: "prod-l4", runId: "rar_ask", seq });

    /* Paused for an admin: over, though 20 cr alone is under the 50 cr cap. */
    await setSetting("shotCapCredits", "50", "boss");
    expect(await lib.askAdmin(me, step(1), deps)).toMatchObject({ asked: 1 });
    /* What the shot holds plus this render exactly at the cap is not over it: refused, nobody told. */
    await setSetting("shotCapCredits", String(held + 20), "boss");
    await expect(lib.askAdmin(me, step(2), deps)).rejects.toMatchObject({ status: 409, message: lib.ASK_NOT_OVER });
    expect(told).toHaveLength(1);
    /* The refused ask counted: asked again at once, it is not judged again. */
    await expect(lib.askAdmin(me, step(2), deps)).rejects.toMatchObject({ status: 429 });
    /* A credit over the cap with what the shot holds (the render alone is far under it): over, told, after the window. */
    await setSetting("shotCapCredits", String(held + 19), "boss");
    now += 11 * 60_000;
    expect(await lib.askAdmin(me, step(2), deps)).toMatchObject({ asked: 1 });
    expect(told).toHaveLength(2);
    /* Within ten minutes: refused, nobody told twice; another person is their own count. */
    now += 5 * 60_000;
    await expect(lib.askAdmin(me, step(2), deps)).rejects.toMatchObject({ status: 429 });
    expect(await lib.askAdmin({ ...me, id: "mem2" }, step(2), deps)).toMatchObject({ asked: 1 });
    expect(told).toHaveLength(3);
    await setSetting("approvalRule", "anyone", "boss");
    await setSetting("shotCapCredits", "50", "boss");
  });
});

test("before Approve at the plan gate, the server says where the plan's at most takes the production: past 80 % of its budget, or more than it has left (it stops at the cap)", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const { db } = await import("../../lib/db");
  const store = await import("../../lib/workbench/rig-agent-store");
  const api = await harness();
  mode = "session";
  await runInTenant(WS, async () => {
    await store.rigAgentReady();
    /* One live run per production: the earlier test's run has ended. */
    await db().execute("UPDATE rig_agent_runs SET state='done' WHERE production_id='prod-l4'");
    const take = (id: string, seq: number, quote: number) => ({
      sql: "INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,node_id,prepared,state,quote_credits,band,admission,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0)",
      args: [id, "rar_gate", seq, "render", `Render Shot ${seq}`, "take", `node-${seq}`, "{}", "waiting", quote, 1, JSON.stringify({ quote: { fingerprint: `fp-${seq}` } })],
    });
    await db().batch([
      { sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,plan,cap_credits,per_job_cap,created_at,updated_at) VALUES('rar_gate','prod-l4','d','boss','req-gate','g','auto','needs_you',NULL,500,200,0,0)", args: [] },
      take("st_g1", 1, 43), take("st_g2", 2, 43), take("st_g3", 3, 7),
    ], "write");
  });
  const read = async () => (await (await api.budget.GET(req("/api/workbench/budget?productionId=prod-l4&runId=rar_gate", "GET"), undefined as never)).json()) as { budget: { used: number } | null; plan: { atMost: number; line: string | null } | null };
  const set = (k: string, v: string) => runInTenant(WS, () => setSetting(k, v, "boss"));
  /* The plan: 43 + 43 + 7 = 93 cr, at most 186 cr with fixes (the server's own quote, as the card shows it). A 1,000 cr budget holds it. */
  await set("productionBudgetCredits", "1000");
  const first = await read();
  expect(first).toMatchObject({ plan: { atMost: 186, line: null } });
  /* What the production has already used (an earlier take on it), as the gate counts it. */
  const used = Math.round(first.budget!.used);
  /* 200 cr left: the plan fits, and takes it past the 80 % ask. */
  await set("productionBudgetCredits", String(used + 200));
  expect((await read()).plan!.line).toBe(`This plan can take A 15-second film past 80 % of its budget (${(used + 186).toLocaleString("en-US")} of ${(used + 200).toLocaleString("en-US")} cr).`);
  /* 150 cr left: more than it has left; it will stop at the cap (or go past with a warning, where the rule only warns). */
  await set("productionBudgetCredits", String(used + 150));
  expect((await read()).plan!.line).toBe("This plan’s at most 186 cr is more than A 15-second film has left (150 cr); it will stop at the cap.");
  await set("atCap", "warn");
  expect((await read()).plan!.line).toBe("This plan’s at most 186 cr is more than A 15-second film has left (150 cr); it goes past the cap with a warning.");
  await set("atCap", "producer");
  /* Unlocked past its cap by an admin: nothing to say. No budget: nothing to say. No run named: no plan figure. */
  await exec("UPDATE projects SET cap_unlocked=1 WHERE id='prod-l4'");
  expect((await read()).plan!.line).toBeNull();
  await exec("UPDATE projects SET cap_unlocked=0 WHERE id='prod-l4'");
  const noRun = await (await api.budget.GET(req("/api/workbench/budget?productionId=prod-l4", "GET"), undefined as never)).json() as { plan: unknown };
  expect(noRun.plan).toBeNull();
  await set("productionBudgetCredits", "");
  expect((await (await api.budget.GET(req("/api/workbench/budget?productionId=prod-l4&runId=rar_gate", "GET"), undefined as never)).json() as { budget: unknown; plan: unknown })).toMatchObject({ budget: null, plan: null });
  /* Reading it spends nothing and approves nothing. */
  expect(await runInTenant(WS, async () => (await db().execute("SELECT state FROM rig_agent_runs WHERE id='rar_gate'")).rows[0].state)).toBe("needs_you");
});
