import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { filterRuns, runStats, settledValue, type ActivityRun } from "../../lib/control-room/activity";

/**
 * Activity (lib/control-room/activity*.ts, GET /api/control-room/activity):
 * runs with every step priced and settled from this workspace's ledger only,
 * nothing "held", Auto's renders marked "spent without asking", names by the
 * usage ledger's rule, no figures where credits aren't billed, nothing written,
 * and the route for people only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-control-room-activity-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
process.env.RIG_AGENT_ENABLED = "1";

const now = Date.now();
const T = now.toString(36);
const MODEL = "dreamina-seedance-2-0-260128";
const RUN = `rar_${"c".repeat(24)}`;
const ids = { turn: `amsg_turn_${T}`, done: `gen_done_${T}`, flying: `gen_fly_${T}`, auto: `gen_auto_${T}`, foreign: `gen_foreign_${T}` };

function workspace(id: string): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_member", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 4, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}
const A = workspace(`ws_acta${T}`), B = workspace(`ws_actb${T}`), HOUSE = workspace("ws_legacy");

async function seed(ws: TenantWorkspace, rich: boolean) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  await platformReady();
  await runInTenant(ws, async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_member','member@example.invalid','Member','x',0)",
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_admin','admin@example.invalid','Admin','x',0)",
      "INSERT INTO projects(id,name,created_at) VALUES('prod_a','Project one',0)",
      "INSERT INTO projects(id,name,created_at) VALUES('prod_b','Project two',0)",
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,updated_at) VALUES('k1','u_member','draft_a','Project one',?,?)", args: [JSON.stringify({ productionProjectId: "prod_a" }), now] },
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_a','prod_a','Hero takes','idle','u_member',?,?)", args: [now - 90_000, now - 10_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('m_u','ach_a','user','Plan the hero takes',?)", args: [now - 90_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,'ach_a','assistant','Plan',?)", args: [ids.turn, now - 80_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,gen_id,claimed_by,created_at,updated_at) VALUES('s1','ach_a',?,0,'video','Keyframes',?,'done',0.5,?,'u_admin',?,?)", args: [ids.turn, MODEL, ids.done, now - 80_000, now - 70_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,gen_id,claimed_by,created_at,updated_at) VALUES('s2','ach_a',?,1,'video','Hero take',?,'done',2,?,'u_member',?,?)", args: [ids.turn, MODEL, ids.flying, now - 80_000, now - 60_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,gen_id,claimed_by,created_at,updated_at) VALUES('s3','ach_a',?,2,'video','Elsewhere',?,'done',1,?,'u_member',?,?)", args: [ids.turn, MODEL, ids.foreign, now - 80_000, now - 50_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('s4','ach_a',?,3,'video','Turned down',?,'rejected',1,?,?)", args: [ids.turn, MODEL, now - 80_000, now - 40_000] },
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_b','prod_b','Other project','idle','u_member',?,?)", args: [now - 30_000, now - 30_000] },
    ], "write");
    if (!rich) return;
    await rigAgentReady();
    await db().batch([
      { sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,lease_until,created_at,updated_at)
              VALUES(?,'prod_a','draft_a','u_member','req1','Three shots','auto',100,200,'auto','done',0,?,?)`, args: [RUN, now - 20_000, now - 5_000] },
      { sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,approved_by,approved_at,job_id,credits_settled,created_at,updated_at)
              VALUES(?,?,4,'render','The opening','take','[]','done',7,1,'auto',?,?,7,?,?)`, args: [`${RUN}:4`, RUN, now - 15_000, ids.auto, now - 20_000, now - 5_000] },
    ], "write");
  });
  if (ws.id === A.id) {
    const row = (id: string, workspaceId: string, project: string, status: string, credits: number) => ({
      sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,'video','byteplus',?,?,1,?,1,'u_x',?,?)",
      args: [id, workspaceId, project, MODEL, status, credits, now, now],
    });
    await platformDb().batch([
      row(ids.turn, A.id, "prod_a", "succeeded", 2),
      row(ids.done, A.id, "prod_a", "succeeded", 9),
      row(ids.flying, A.id, "prod_a", "running", 43),
      row(ids.foreign, `ws_elsewhere_${T}`, "prod_a", "succeeded", 77),
      row(`gen_tile_b_${T}`, A.id, "prod_b", "succeeded", 5),
    ], "write");
  }
}

async function read(ws: TenantWorkspace, viewer: { id: string; role: string }, production: string | null) {
  const { runInTenant } = await import("../../lib/tenant");
  const { readActivity } = await import("../../lib/control-room/activity.server");
  return runInTenant(ws, () => readActivity(viewer, production));
}

test.beforeAll(async () => {
  await seed(A, true);
  await seed(B, false);
  await seed(HOUSE, true);
});

test("a production's runs: steps priced and settled from this workspace's ledger, in flight as settling, never a held figure", async () => {
  const reply = await read(A, { id: "u_member", role: "member" }, "prod_a");
  expect(reply.runs.map((r) => r.id)).toEqual([`board:${RUN}`, "thread:ach_a"]);
  const thread = reply.runs.find((r) => r.id === "thread:ach_a")!;
  expect(thread).toMatchObject({ n: 1, title: "Hero takes", state: "running", settled: 11, settling: true, request: "Plan the hero takes" });
  expect(thread.project).toEqual({ productionId: "prod_a", draftId: "draft_a", name: "Project one" });
  const step = (title: string) => thread.steps.find((s) => s.title === title)!;
  expect(thread.steps.find((s) => s.kind === "thinking")?.settled).toEqual({ kind: "settled", credits: 2 });
  expect(step("Keyframes")).toMatchObject({ settled: { kind: "settled", credits: 9 }, state: "done", by: "Teammate", byYou: false });
  expect(step("Keyframes").priced?.kind).toBe("up-to");
  expect(step("Hero take")).toMatchObject({ settled: { kind: "settling" }, state: "running", by: "Member", byYou: true });
  /* Another workspace's meter row is never read: no figure rather than its 77. */
  expect(step("Elsewhere").settled).toEqual({ kind: "unknown" });
  expect(step("Turned down")).toMatchObject({ state: "turned down", settled: { kind: "nothing" } });
  const board = reply.runs.find((r) => r.id === `board:${RUN}`)!;
  expect(board).toMatchObject({ n: 2, state: "done", settled: 7, settling: false });
  expect(board.steps.find((s) => s.kind === "paid")).toMatchObject({ auto: true, by: null, settled: { kind: "settled", credits: 7 } });
  expect(JSON.stringify(reply)).not.toMatch(/held|estUsd|est_cost|engine_cost|cost_usd|\$|ws_elsewhere/);
});

test("settled per project counts only settled meter rows of this workspace", async () => {
  const reply = await read(A, { id: "u_member", role: "member" }, "prod_a");
  /* prod_a: 2 + 9 settled (43 still running, 77 another workspace's); prod_b: 5. */
  expect(reply.projects).toEqual([
    { project: { productionId: "prod_a", draftId: "draft_a", name: "Project one" }, settled: 11 },
    { project: { productionId: "prod_b", draftId: null, name: "Project two" }, settled: 5 },
  ]);
  const b = await read(B, { id: "u_member", role: "member" }, null);
  expect(b.projects).toEqual([]);
  expect(b.runs.map((r) => r.id).sort()).toEqual(["thread:ach_a", "thread:ach_b"]);
  expect(b.runs.every((r) => r.settled === 0)).toBe(true);
});

test("an admin reads names; a workspace not billed in credits gets no figures", async () => {
  const admin = await read(A, { id: "u_admin", role: "admin" }, "prod_a");
  const keyframes = admin.runs.find((r) => r.id === "thread:ach_a")!.steps.find((s) => s.title === "Keyframes")!;
  expect(keyframes).toMatchObject({ by: "Admin", byYou: true });
  const house = await read(HOUSE, { id: "u_member", role: "member" }, "prod_a");
  expect(house.inCredits).toBe(false);
  expect(house.projects).toEqual([]);
  for (const run of house.runs) {
    expect(run.settled).toBe(0);
    for (const s of run.steps) { expect(s.priced).toBeNull(); expect(s.settled).toEqual({ kind: "unbilled" }); }
  }
});

test("reading changes nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const snapshot = () => runInTenant(A, async () => JSON.stringify(await Promise.all([
    db().execute("SELECT id,state,updated_at,wake_at,lease_until FROM rig_agent_runs ORDER BY id"),
    db().execute("SELECT id,status,updated_at FROM atomik_steps ORDER BY id"),
    db().execute("SELECT id,status,updated_at FROM atomik_chats ORDER BY id"),
  ].map((p) => p.then((r) => r.rows)))));
  const before = await snapshot();
  await read(A, { id: "u_member", role: "member" }, "prod_a");
  await read(A, { id: "u_member", role: "member" }, null);
  expect(await snapshot()).toBe(before);
});

test("the pure model: filters, stats and the run figure", () => {
  const run = (over: Partial<ActivityRun>): ActivityRun => ({
    id: "r", source: "thread", n: 1, title: "t", project: { productionId: null, draftId: null, name: null }, startedAt: 0, state: "done",
    reason: null, steps: [], settled: 0, settling: false, request: "", open: { kind: "thread", chatId: "c", productionId: null }, ...over,
  });
  const runs = [run({ id: "a", state: "planning" }), run({ id: "b", state: "running", settled: 3 }), run({ id: "c", state: "needs-you" }), run({ id: "d", state: "done", settled: 9 }), run({ id: "e", state: "stopped" })];
  expect(filterRuns(runs, "Running").map((r) => r.id)).toEqual(["a", "b"]);
  expect(filterRuns(runs, "Needs you").map((r) => r.id)).toEqual(["c"]);
  expect(filterRuns(runs, "Done").map((r) => r.id)).toEqual(["d", "e"]);
  expect(filterRuns(runs, "All")).toHaveLength(5);
  expect(runStats(runs)).toEqual({ running: 2, needsYou: 1, settled: 12 });
  expect(settledValue(run({ settled: 0 }))).toBeNull();
  expect(settledValue(run({ settled: 9 }))).toEqual({ kind: "exact", credits: 9 });
});

/* ── The route ──────────────────────────────────────────────────────────── */

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

test("the route: a person reads their own workspace only; signed out, a token or a bad id is refused", async () => {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const server = await import("../../lib/control-room/activity.server");
  let selected = A, mode: "session" | "token" | "none" = "session", bearer = "";
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope, "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => (mode === "session" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(mode === "token" ? { authorization: `Bearer ${bearer}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => ({ account: { id: "u_member", name: "Member", email: "member@example.invalid", mfa_enabled: 1 }, workspaceId: selected.id }),
      workspacesFor: async () => [{ workspace: selected, role: "member" }],
      getWorkspace: async (id: string) => (selected.id === id ? selected : null),
      legacyWorkspace: async () => null, platformReady: async () => {},
      platformDb: () => ({ execute: async () => ({ rows: [{ role: "member" }] }) }),
    },
  });
  const route = load<typeof import("../../app/api/control-room/activity/route")>("app/api/control-room/activity/route.ts", {
    "@/lib/auth": auth, "@/lib/control-room/activity.server": server,
  });
  const get = (q = "") => route.GET(new Request(`http://localhost/api/control-room/activity${q}`), undefined as never);

  const a = await (await get("?production=prod_a")).json();
  expect(a.runs.map((r: { id: string }) => r.id)).toContain(`board:${RUN}`);
  selected = B;
  const b = await (await get("?production=prod_a")).json();
  expect(JSON.stringify(b)).not.toContain(RUN);
  expect(b.runs.map((r: { id: string }) => r.id)).toEqual(["thread:ach_a"]);
  expect((await get("?production=../etc")).status).toBe(400);
  mode = "none";
  expect((await get()).status).toBe(401);
  const raw = `pk_${A.id.replace(/^ws_/, "")}_${"7".repeat(48)}`;
  selected = A;
  await tenant.runInTenant(A, () => database.db().execute({
    sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_act',?,'agent','u_member','render',0)",
    args: [auth.tokenHash(raw)],
  }));
  mode = "token"; bearer = raw;
  expect((await get("?production=prod_a")).status).toBe(403);
});
