import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The approvals read (lib/control-room/approvals.server.ts): what waits for a
 * person in one workspace, never another's; who may press what, as each
 * record's own rule says; prices in credits only, from the server's own
 * figures; nothing written; and the decisions of the last days with the usage
 * ledger's naming rule.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-control-room-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
/* Fixture credit rows (grants, meter) are stamped 0, as tests/helpers/fundFixtureWorkspace.ts does: a row stamped now would
   make the shared platform database's ledger seed read as the old price and pause paid work for later specs (lib/ledgerUnit.ts). */
process.env.RIG_AGENT_ENABLED = "1";

function workspace(id: string): TenantWorkspace {
  return {
    id, slug: id, name: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_member", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 4, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

const MODEL = "dreamina-seedance-2-0-260128";
const FP = (c: string) => c.repeat(64);
const RUN_ONE = `rar_${"1".repeat(24)}`, RUN_TWO = `rar_${"2".repeat(24)}`;
const now = Date.now();
/* Ids in the platform database are unique per run: every unit spec in a worker shares it. */
const T = now.toString(36);
const DONE = `gen_done_${T}`, CROSS = `gen_cross_${T}`;

async function seed(ws: TenantWorkspace, opts: { credits?: number; rich?: boolean; heldId: string }) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { setSetting } = await import("../../lib/settings");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  await platformReady();
  if (opts.credits) await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)", args: [`grant_${ws.id}_${T}`, ws.id, opts.credits, 0] });
  await runInTenant(ws, async () => {
    await ready();
    const held = (id: string, why: "credits" | "slots", extra: Record<string, unknown> = {}, by = "u_member") => ({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,project_id)
            VALUES(?,'video','byteplus',?,'A quiet street at dawn',?,'held',?,?,?,?)`,
      args: [id, MODEL, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, held: { estUsd: 1, needs: 15, at: 1, why }, ...extra }), by, now - 60_000, now - 60_000, "prod_a"],
    });
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_member','member@example.invalid','Member','x',0)",
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_admin','admin@example.invalid','Admin','x',0)",
      "INSERT INTO users(id,email,name,password_hash,created_at) VALUES('u_other','other@example.invalid','Other','x',0)",
      { sql: "INSERT INTO projects(id,name,created_at) VALUES('prod_a','Project one',0)", args: [] },
      { sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,updated_at) VALUES(?,?,?,?,?,?)", args: ["k1", "u_member", "draft_a", "Project one", JSON.stringify({ productionProjectId: "prod_a" }), now] },
      held(opts.heldId, "credits"),
    ], "write");
    if (!opts.rich) return;
    await db().batch([
      { sql: "INSERT INTO projects(id,name,created_at) VALUES('prod_b','Project two',0)", args: [] },
      held("gen_slot", "slots"),
      held("gen_demo", "credits", { demo: true }),
      /* A plan whose last answer has two steps waiting; an older answer's step is not the checkpoint. */
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_1','prod_a','Hero takes','waiting','u_member',?,?)", args: [now - 50_000, now - 40_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('m_u','ach_1','user','Plan the hero takes',?)", args: [now - 50_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('m_old','ach_1','assistant','First plan',?)", args: [now - 49_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('m_new','ach_1','assistant','Second plan',?)", args: [now - 45_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('astp_old','ach_1','m_old',0,'video','Stale step',?,'proposed',0.5,?,?)", args: [MODEL, now - 49_000, now - 49_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('astp_b','ach_1','m_new',1,'video','Hero take',?,'proposed',2,?,?)", args: [MODEL, now - 45_000, now - 45_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('astp_a','ach_1','m_new',0,'video','Keyframes',?,'proposed',0.5,?,?)", args: [MODEL, now - 45_000, now - 45_000] },
      /* An archived thread waits for nobody. */
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_arch','prod_a','Old','waiting','u_member',?,?)", args: [now - 50_000, now - 50_000] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('m_arch','ach_arch','assistant','Plan',?)", args: [now - 50_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('astp_arch','ach_arch','m_arch',0,'video','Archived',?,'proposed',1,?,?)", args: [MODEL, now - 50_000, now - 50_000] },
      { sql: "UPDATE atomik_chats SET archived_at=? WHERE id='ach_arch'", args: [now - 1_000] },
      /* Decided: a step an admin continued, settled in this workspace's meter; another whose meter row is another workspace's. */
      { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_2','prod_a','Done','idle','u_member',?,?)", args: [now - 30_000, now - 20_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,gen_id,claimed_by,created_at,updated_at) VALUES('astp_done','ach_2','m_x',0,'video','Plates',?,'done',1,?,'u_admin',?,?)", args: [MODEL, DONE, now - 30_000, now - 20_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,gen_id,claimed_by,created_at,updated_at) VALUES('astp_cross','ach_2','m_x',1,'video','Elsewhere',?,'done',1,?,'u_member',?,?)", args: [MODEL, CROSS, now - 30_000, now - 19_000] },
      { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,model,status,est_cost_usd,created_at,updated_at) VALUES('astp_no','ach_2','m_x',2,'video','Turned down',?,'rejected',1,?,?)", args: [MODEL, now - 30_000, now - 18_000] },
    ], "write");
    await rigAgentReady();
    const run = (id: string, production: string, state: string) => ({
      sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,lease_until,created_at,updated_at)
            VALUES(?,?,'draft_a','u_member',?,'Three shots on the board','ask',100,200,'auto',?,0,?,?)`,
      args: [id, production, `req_${id}`, state, now - 30_000, now - 30_000],
    });
    const render = (runId: string, seq: number, quote: number, fp: string) => ({
      sql: `INSERT INTO rig_agent_steps(id,run_id,seq,tool,label,purpose,prepared,state,quote_credits,band,admission,created_at,updated_at)
            VALUES(?,?,?,'render','Render the opening','take','[]','waiting',?,1,?,?,?)`,
      args: [`${runId}:${seq}`, runId, seq, quote, JSON.stringify({ quote: { fingerprint: fp } }), now - 30_000, now - 30_000],
    });
    await db().batch([run(RUN_ONE, "prod_a", "needs_you"), render(RUN_ONE, 4, 30, FP("a")), run(RUN_TWO, "prod_b", "needs_you"), render(RUN_TWO, 2, 43, FP("b"))], "write");
    await setSetting("approvalRule", "cap", "u_admin");
    await setSetting("shotCapCredits", "40", "u_admin");
  });
  /* Meter ids are the platform's own keys: seeded once, for the workspace the decisions are read in. */
  if (opts.rich && ws.id === A.id) {
    await platformDb().batch([
      { sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,'prod_a','video','byteplus',?,'succeeded',1,9,1,'u_admin',0,0)", args: [DONE, ws.id, MODEL] },
      { sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,'ws_elsewhere','prod_x','video','byteplus',?,'succeeded',1,77,1,'u_x',0,0)", args: [CROSS, MODEL] },
    ], "write");
  }
}

async function read(ws: TenantWorkspace, viewer: { id: string; role: string; owner?: boolean }) {
  const { runInTenant } = await import("../../lib/tenant");
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  return runInTenant(ws, () => readApprovals(viewer, now));
}

const A = workspace(`ws_s08a${T}`), B = workspace(`ws_s08b${T}`), HOUSE = workspace("ws_legacy");

test.beforeAll(async () => {
  await seed(A, { credits: 1000, rich: true, heldId: "gen_a" });
  await seed(B, { credits: 1000, heldId: "gen_b" });
  await seed(HOUSE, { rich: true, heldId: "gen_house" });
});

test("a workspace reads only what waits in it, and every kind of wait is one item", async () => {
  const a = await read(A, { id: "u_member", role: "member" });
  const ids = a.items.map((i) => i.id).sort();
  expect(ids).toEqual(["board-render:" + RUN_ONE + ":4", "board-render:" + RUN_TWO + ":2", "held:gen_a", "held:gen_demo", "thread:ach_1"].sort());
  expect(JSON.stringify(a)).not.toContain("gen_b");
  const b = await read(B, { id: "u_member", role: "member" });
  expect(b.items.map((i) => i.id)).toEqual(["held:gen_b"]);
  expect(JSON.stringify(b)).not.toMatch(/gen_a|ach_1|rar_/);
});

test("prices are the server's own, in credits, worded kinds only; no dollar figure leaves the read", async () => {
  const { billCredits, marginKeyOf, heldPriceNow } = await import("../../lib/creditTerms");
  const a = await read(A, { id: "u_member", role: "member" });
  const held = a.items.find((i) => i.id === "held:gen_a")!;
  const needs = heldPriceNow({ estUsd: 1, needs: 15 }, "video", MODEL);
  expect(held.price).toEqual({ kind: "exact", credits: needs });
  expect(held.approve).toEqual({ kind: "release", genId: "gen_a", credits: needs });
  /* A plan's checkpoint: the first waiting step of its last answer, priced up to its estimate in credits. */
  const step = a.items.find((i) => i.id === "thread:ach_1")!;
  expect(step.price).toEqual({ kind: "up-to", credits: billCredits(0.5, marginKeyOf("video", MODEL)) });
  expect(step.step).toEqual({ n: 1, of: 2 });
  expect(step.approve).toEqual({ kind: "thread", chatId: "ach_1", stepId: "astp_a", productionId: "prod_a" });
  expect(step.title).toBe("Hero takes");
  const render = a.items.find((i) => i.id === `board-render:${RUN_ONE}:4`)!;
  expect(render.price).toEqual({ kind: "exact", credits: 30 });
  expect(render.approve).toEqual({ kind: "board-render", productionId: "prod_a", runId: RUN_ONE, seq: 4, fingerprint: FP("a") });
  /* The viewer's own draft of the production rides along, for Home's project cards. */
  expect(held.project).toEqual({ productionId: "prod_a", draftId: "draft_a", name: "Project one" });
  expect(held.open).toEqual({ kind: "take", genId: "gen_a", draftId: "draft_a" });
  const json = JSON.stringify(a);
  expect(json).not.toMatch(/estUsd|est_cost|engine_cost|cost_usd|\$/);
  expect(a.items.find((i) => i.id === "held:gen_demo")?.sample).toBe(true);
});

test("who may press follows each record's own rule, and the per-shot rule never gives a member more", async () => {
  const member = await read(A, { id: "u_member", role: "member" });
  const other = await read(A, { id: "u_other", role: "member" });
  const admin = await read(A, { id: "u_admin", role: "admin" });
  const pick = (r: typeof member, id: string) => r.items.find((i) => i.id === id)!;
  /* A held take: its maker or an admin. */
  expect(pick(member, "held:gen_a")).toMatchObject({ canApprove: true, why: null });
  expect(pick(other, "held:gen_a")).toMatchObject({ canApprove: false, why: "Only the person who made this take, or an admin, can release it.", decline: null });
  expect(pick(admin, "held:gen_a").canApprove).toBe(true);
  /* A board render: only the person who asked, and under the 40 cr rule for a member. */
  expect(pick(member, `board-render:${RUN_ONE}:4`)).toMatchObject({ canApprove: true, needsAdmin: false });
  expect(pick(other, `board-render:${RUN_ONE}:4`)).toMatchObject({ canApprove: false, why: "Only the person who asked Atomik for this run can approve its renders." });
  expect(pick(member, `board-render:${RUN_TWO}:2`)).toMatchObject({ canApprove: false, needsAdmin: true, why: "Members up to 40 cr a shot; an admin above it" });
  /* A plan's step: any member, at its live price. */
  expect(pick(other, "thread:ach_1").canApprove).toBe(true);
});

test("decisions read the meter of this workspace only, and name people as the usage ledger does", async () => {
  const member = await read(A, { id: "u_member", role: "member" });
  const admin = await read(A, { id: "u_admin", role: "admin" });
  const done = (r: typeof member) => r.decided.find((d) => d.id === "thread-step:astp_done")!;
  expect(done(member)).toMatchObject({ what: "approved", by: "Teammate", byYou: false, outcome: { kind: "settled", credits: 9 } });
  expect(done(admin)).toMatchObject({ by: "Admin", byYou: true });
  /* A meter row of another workspace is never read: no figure, rather than its 77. */
  expect(member.decided.find((d) => d.id === "thread-step:astp_cross")?.outcome).toEqual({ kind: "unknown" });
  /* Turned down before anything was sent: nothing was charged. */
  expect(member.decided.find((d) => d.id === "thread-step:astp_no")).toMatchObject({ what: "turned down", by: null, outcome: { kind: "nothing" } });
});

test("a workspace not billed in credits gets no figures at all, and can still continue a plan", async () => {
  const house = await read(HOUSE, { id: "u_member", role: "member" });
  expect(house.inCredits).toBe(false);
  for (const item of house.items) expect(item.price === null || item.price.kind === "free").toBe(true);
  expect(house.items.find((i) => i.id === "thread:ach_1")?.canApprove).toBe(true);
  for (const d of house.decided) expect(d.outcome).toEqual({ kind: "unbilled" });
});

test("reading changes nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const snapshot = () => runInTenant(A, async () => JSON.stringify(await Promise.all([
    db().execute("SELECT id,status,params,updated_at FROM generations ORDER BY id"),
    db().execute("SELECT id,state,updated_at,wake_at,lease_until FROM rig_agent_runs ORDER BY id"),
    db().execute("SELECT id,status,updated_at FROM atomik_steps ORDER BY id"),
  ].map((p) => p.then((r) => r.rows)))));
  const before = await snapshot();
  await read(A, { id: "u_member", role: "member" });
  expect(await snapshot()).toBe(before);
});
