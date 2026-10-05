import { test, expect } from "@playwright/test";
import path from "node:path";

/**
 * Phase SEED (no server): particl.si as it stands, a ledger first booted at CREDIT_USD=0.80,
 * with rows written before the cutover (US$0.10 credits) and after it (US$0.80 credits).
 */
const root = path.resolve(__dirname, "../../../.data/conv-rehearsal");
const CUTOVER = Date.parse("2026-10-03T14:39:00Z");
const PRE = CUTOVER - 2 * 86_400_000;
const POST = CUTOVER + 3_600_000;

const WS: [string, string, string][] = [
  ["ws_northlight", "Northlight", "ana@northlight.example.org"],
  ["ws_harbour", "Harbour Films", "ben@harbour.example.org"],
  ["ws_kite", "Kite Studio", "cy@kite.example.org"],
  ["ws_meridian", "Meridian", "di@meridian.example.org"],
  ["ws_lowtide", "Lowtide", "ed@lowtide.example.org"],
  ["ws_fieldnote", "Fieldnote", "fa@fieldnote.example.org"],
  ["ws_saltmarsh", "Saltmarsh", "gi@saltmarsh.example.org"],
  ["ws_fixture", "E2E fixture", "bot@example.test"],
];

test("seed a two-unit record", async () => {
  test.skip(process.env.PHASE !== "seed");
  expect(process.env.CREDIT_USD).toBe("0.80");
  const { platformDb, platformReady, getWorkspace } = await import("../../../lib/platform");
  const { billingReady, billingTransaction, syncBillingLedger, applyPaidSubscriptionPeriod, addBillingMonths } = await import("../../../lib/billingLedger");
  const { runInTenant } = await import("../../../lib/tenant");
  const { db, ready } = await import("../../../lib/db");
  await platformReady();
  await billingReady(); // first boot at 0.80: the ledger's unit is seeded here
  const p = platformDb();
  for (const [id, name, email] of WS) {
    await p.execute({ sql: `INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,'!',?)`, args: [`acct_${id}`, email, name, PRE] });
    await p.execute({
      sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,internal_test) VALUES(?,?,?,?,?,1,?,?,?)`,
      args: [id, id.replace("ws_", ""), name, `file:${path.join(root, `${id}.db`)}`, `acct_${id}`, PRE, PRE, id === "ws_fixture" ? 1 : 0],
    });
    await p.execute({ sql: `INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',?)`, args: [id, `acct_${id}`, PRE] });
  }
  const grant = (ws: string, id: string, credits: number, kind: string, at: number, note = "") =>
    p.execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,?,?,?,?)`, args: [id, ws, credits, note, kind, at] });
  const job = async (ws: string, id: string, credits: number, unit: number, at: number, status = "succeeded", cost = 1) => {
    await p.execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,credit_usd,credit_margin)
        VALUES(?,?,'video','byteplus','mock-seedance',?,?,?,1,?,?,?,1)`, args: [id, ws, status, cost, credits, at, at, unit] });
    await billingTransaction(async (tx) => { await syncBillingLedger(tx, ws, at); }, at);
  };
  // Plain: welcome at $0.10 before the cutover, one job at $0.10.
  await grant("ws_northlight", "welcome:ws_northlight", 250, "welcome", PRE, "Welcome");
  await job("ws_northlight", "job_n1", 20, 0.10, PRE + 3_600_000);
  // Spent $0.10 welcome credits on a $0.80 job after the cutover: the owner decides.
  await grant("ws_harbour", "welcome:ws_harbour", 250, "welcome", PRE, "Welcome");
  await job("ws_harbour", "job_h1", 30, 0.80, POST);
  // A Starter pack bought at $0.80 ($400 for 500), and a Team pack still open at $0.80 terms.
  await p.execute({ sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at,decided_at) VALUES('req_kite_1','ws_kite','starter','Starter',500,0,400,'approved',?,?)`, args: [POST, POST] });
  await grant("ws_kite", "topup:req_kite_1:purchase", 500, "purchase", POST, "Starter pack");
  await p.execute({ sql: `INSERT INTO topup_requests(id,workspace_id,pack_id,label,credits,bonus_credits,usd,status,created_at,requested_by) VALUES('req_kite_2','ws_kite','team','Team',2000,200,1600,'requested',?,'acct_ws_kite')`, args: [POST + 1000] });
  // A plan inclusion with its expiry, paid after the cutover, and a job on it.
  await applyPaidSubscriptionPeriod({ workspaceId: "ws_meridian", provider: "manual", subscriptionId: "sub_meridian", invoiceId: "inv_meridian_1", planId: "studio",
    interval: "month", includedCredits: 400, periodStart: POST, periodEnd: addBillingMonths(POST, 1), paidUsd: 49 }, POST);
  await job("ws_meridian", "job_m1", 30, 0.80, POST + 60_000);
  // Debt: 10 granted, 30 spent, at $0.80.
  await grant("ws_lowtide", "manual:ws_lowtide", 10, "manual", POST, "Desk grant");
  await job("ws_lowtide", "job_l1", 30, 0.80, POST + 60_000);
  // A job running across the switch: reserved now, at $0.80, through the real reservation.
  await grant("ws_fieldnote", "manual:ws_fieldnote", 100, "manual", POST, "Desk grant");
  const { reserveGenerationSpend } = await import("../../../lib/generationRequests");
  await runInTenant((await getWorkspace("ws_fieldnote"))!, () =>
    reserveGenerationSpend({ id: "job_f_running", kind: "video", engine: "byteplus", model: "mock-seedance", status: "running", engineCostUsd: 2 }));
  // A held take, a shot cap, a token ceiling and an approved Atomik run limit, set after the cutover.
  await grant("ws_saltmarsh", "manual:ws_saltmarsh", 2, "manual", POST, "Desk grant");
  await runInTenant((await getWorkspace("ws_saltmarsh"))!, async () => {
    await ready();
    const { rigAgentReady } = await import("../../../lib/workbench/rig-agent-store");
    await rigAgentReady();
    await db().execute({ sql: `INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES('acct_ws_saltmarsh','gi@saltmarsh.example.org','Gi','!','admin',0,?)`, args: [POST] });
    await db().execute({ sql: `INSERT INTO settings(key,value,updated_by,updated_at) VALUES('approvalRule','cap','acct_ws_saltmarsh',?),('shotCapCredits','25','acct_ws_saltmarsh',?)`, args: [POST, POST] });
    await db().execute({ sql: `INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_credits,created_at) VALUES('tok_s','hash_s','CI','acct_ws_saltmarsh','render',50,?)`, args: [POST] });
    await db().execute({ sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind) VALUES('held_s1','mock-seedance','',?,'held',?,?,'video')`,
      args: [JSON.stringify({ held: { estUsd: 0.5, needs: 1, at: POST, why: "credits" } }), POST, POST] });
    await db().execute({ sql: `INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,mode,cap_credits,per_job_cap,model,state,limits,approved_at,created_at,updated_at)
      VALUES('run_s1','prod_s','draft_s','acct_ws_saltmarsh','req_s1','Cut a teaser','ask',60,25,'mock','running',?,?,?,?)`,
      args: [JSON.stringify([{ credits: 60, jobCeiling: 25, at: POST }]), POST, POST, POST] });
  });
  // A test workspace, marked, not excluded.
  await grant("ws_fixture", "manual:ws_fixture", 40, "manual", POST, "Fixture");
  const unit = (await p.execute(`SELECT unit_usd FROM billing_unit WHERE id=1`)).rows[0];
  expect(Number(unit.unit_usd)).toBe(0.8);
});

test("settle the job that ran across the switch", async () => {
  test.skip(process.env.PHASE !== "settle");
  const { getWorkspace, platformDb } = await import("../../../lib/platform");
  const { runInTenant } = await import("../../../lib/tenant");
  const { meter } = await import("../../../lib/meter");
  const { billingStateFor } = await import("../../../lib/billingLedger");
  const before = (await billingStateFor("ws_fieldnote")).credits.balance;
  for (let i = 0; i < 2; i++)
    await runInTenant((await getWorkspace("ws_fieldnote"))!, () =>
      meter({ id: "job_f_running", kind: "video", engine: "byteplus", model: "mock-seedance", status: "succeeded", engineCostUsd: 2 }));
  const row = (await platformDb().execute(`SELECT billed_credits,credit_usd FROM meter_events WHERE id='job_f_running'`)).rows[0];
  const after = (await billingStateFor("ws_fieldnote")).credits.balance;
  const unit = Number((await platformDb().execute(`SELECT unit_usd FROM billing_unit WHERE id=1`)).rows[0].unit_usd);
  const out = { before, after, billedCredits: Number(row.billed_credits), approvedAtUsd: Number(row.credit_usd), platformLedgerUnit: unit };
  expect(unit).toBe(0.8); // settled between runs: only ws_fieldnote is converted so far
  console.log("SETTLE", JSON.stringify(out));
  (await import("node:fs")).writeFileSync(path.resolve(__dirname, "../../../.data/evidence/settle-between-runs.json"), JSON.stringify(out, null, 2));
  expect(out.billedCredits).toBe(32);
});
