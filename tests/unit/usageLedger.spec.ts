import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  connectedLedgerState, creditLedgerState, dollarLedgerState, ledgerAmount, settledFact,
  type CreditLedgerRow, type DollarLedgerRow, type LedgerState,
} from "../../lib/usageLedgerTerms";

/* Idea 25 — the usage ledger per job. A credit workspace reads what admission
   reserved, settled or released, in credits and nothing else; "not billed" is
   said only of a job the ledger holds at zero; a dollar workspace reads its
   takes in dollars; the viewer's connected account is its provider's credits,
   apart from both. Paged on the server, scoped to the tenant. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-usage-ledger-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const run = randomUUID().slice(0, 8);
function workspace(name: string, credits: boolean, keys: Record<string, string> = {}): TenantWorkspace {
  return {
    id: `ws_ledger_${name}_${run}`, slug: `ledger-${name}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys, usesPlatformKeys: credits,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  };
}
const id = (name: string) => `${name}_${run}`;
const admin = (userId: string) => ({ id: userId, admin: true });
/** A page this workspace must answer in credits. */
function inCredits<P extends { unit: string }>(page: P): Extract<P, { unit: "credits" }> {
  expect(page.unit).toBe("credits");
  return page as Extract<P, { unit: "credits" }>;
}
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
function lastMonthAt(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 12, 10, 0, 0);
}

test("each state is read off the ledger alone: held while reserved, not billed only at zero", () => {
  const cases: [string, number, boolean, LedgerState][] = [
    ["running", 15, true, "held"], ["running", 0, true, "running"], ["running", 0, false, "running"],
    ["succeeded", 12, true, "charged"], ["succeeded", 0, true, "not-billed"], ["succeeded", 0, false, "own-key"],
    ["failed", 0, true, "failed-not-billed"], ["failed", 8, true, "failed-charged"], ["failed", 0, false, "failed-not-billed"],
    /* No other meter status exists; nothing unknown is ever called settled or unbilled. */
    ["mystery", 0, true, "running"], ["mystery", 3, true, "held"],
  ];
  for (const [status, credits, paid, state] of cases) expect(creditLedgerState(status, credits, paid), `${status} ${credits} ${paid}`).toBe(state);
  expect(dollarLedgerState("succeeded", 1.3)).toBe("charged");
  expect(dollarLedgerState("succeeded", 0)).toBe("not-billed");
  expect(dollarLedgerState("succeeded", null)).toBe("unpriced");
  expect(dollarLedgerState("failed", null)).toBe("failed-not-billed");
  expect(dollarLedgerState("cancelled", 0)).toBe("failed-not-billed");
  expect(dollarLedgerState("failed", 0.4)).toBe("failed-charged");
  expect(dollarLedgerState("held", null)).toBe("waiting");
  expect(dollarLedgerState("queued", null)).toBe("running");
  expect(["completed", "accepted", "dispatching", "uncertain", "failed"].map(connectedLedgerState)).toEqual(["completed", "pending", "pending", "uncertain", "failed"]);
});

test("the Inspector's Settled fact never shows a dollar unless the route answered in dollars", () => {
  const credit = (state: LedgerState, credits: number): CreditLedgerRow => ({ id: "g", at: 0, who: null, engine: "Seedance 2.5", kind: "video", credits, state });
  const states: LedgerState[] = ["charged", "held", "running", "not-billed", "own-key", "failed-not-billed", "failed-charged", "waiting", "unpriced"];
  for (const state of states) expect(settledFact({ unit: "credits", rows: [credit(state, 7)] }, null)).not.toContain("$");
  expect(settledFact({ unit: "credits", rows: [credit("held", 15)] }, null)).toBe("Held · 15 cr");
  expect(settledFact({ unit: "credits", rows: [credit("charged", 12)] }, null)).toBe("12 cr");
  expect(settledFact({ unit: "credits", rows: [credit("failed-not-billed", 0)] }, null)).toBe("Not billed");
  expect(settledFact({ unit: "credits", rows: [credit("own-key", 0)] }, null)).toBe("Own key · not billed");
  expect(settledFact({ unit: "credits", rows: [credit("failed-charged", 8)] }, null)).toBe("8 cr · failed");
  expect(settledFact({ unit: "credits", rows: [credit("running", 0)] }, null)).toBe("Not settled");
  /* A row that does not match the unit the route declared is not shown at all. */
  const dollars: DollarLedgerRow = { id: "g", at: 0, who: null, engine: "Seedance 2.5", kind: "video", usd: 1.3, state: "charged" };
  expect(settledFact({ unit: "credits", rows: [dollars] }, null)).toBe("—");
  expect(settledFact({ unit: "usd", rows: [dollars] }, null)).toBe("$1.30");
  expect(settledFact({ unit: "usd", rows: [] }, null)).toBe("—");
  expect(settledFact(null, null)).toBe("Reading…");
  expect(settledFact(null, null, true)).toBe("Could not be read");
  expect(settledFact({ unit: "credits", rows: [credit("charged", 12)] }, "75 connected cr (quoted)")).toBe("75 connected cr (quoted)");
  expect(ledgerAmount(credit("running", 0))).toBe("—");
  expect(ledgerAmount({ ...dollars, usd: 0.0421 })).toBe("$0.042");
});

test("the query is validated and the page marker round-trips", async () => {
  const { parseLedgerQuery, encodeLedgerCursor, decodeLedgerCursor } = await import("../../lib/usageLedger");
  const q = (s: string) => parseLedgerQuery(new URLSearchParams(s));
  expect(q("rows=2")).toEqual({ error: expect.any(String) });
  expect(q("rows=1&month=2026-13")).toEqual({ error: "A month looks like 2026-09." });
  expect(q("rows=1&cursor=not%20a%20cursor")).toEqual({ error: expect.any(String) });
  expect(q("rows=1&cursor=" + Buffer.from('["x","y"]').toString("base64url"))).toEqual({ error: expect.any(String) });
  expect(q("rows=1&limit=5000")).toMatchObject({ source: "ledger", limit: 100 });
  expect(q("rows=connected&limit=0")).toMatchObject({ source: "connected", limit: 1 });
  expect(q("rows=1&month=2026-09&format=csv")).toMatchObject({ month: "2026-09", csv: true, range: { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) } });
  expect(decodeLedgerCursor(encodeLedgerCursor(1_790_000_000_123, "gen_a:b"))).toEqual({ at: 1_790_000_000_123, id: "gen_a:b" });
});

test("a credit workspace reads the ledger: credits from admission, never a dollar, summing to the balance's used", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { meter } = await import("../../lib/meter");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { billingStateFor } = await import("../../lib/billingLedger");
  const { usageLedgerPage, ledgerCsv, parseLedgerQuery, usageLedgerResponse } = await import("../../lib/usageLedger");
  const ws = workspace("credits", true, { openai: "sk-unit-own-key" });
  const other = workspace("neighbour", true);
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,500,'unit','manual',0)", args: [id("grant"), ws.id] });
  const q = (s = "") => parseLedgerQuery(new URLSearchParams(`rows=1${s}`)) as Exclude<ReturnType<typeof parseLedgerQuery>, { error: string }>;
  const video = { kind: "video" as const, engine: "byteplus", model: "dreamina-seedance-2-5-260628" };
  await runInTenant(ws, async () => {
    const { db, ready } = await import("../../lib/db");
    await ready();
    await db().execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u_editor','editor@example.test','Editor','x','admin',0)" });
    /* Reserved and still running: held. */
    await reserveGenerationSpend({ ...video, id: id("held"), status: "running", engineCostUsd: 1, createdBy: "u_editor" });
    /* Reserved, then settled at its actual cost. */
    await reserveGenerationSpend({ ...video, id: id("settled"), status: "running", engineCostUsd: 1, createdBy: "u_editor" });
    await meter({ ...video, id: id("settled"), status: "succeeded", engineCostUsd: 0.8 });
    /* Reserved, then released: the job failed at no cost. */
    await reserveGenerationSpend({ ...video, id: id("released"), status: "running", engineCostUsd: 1, createdBy: "u_editor" });
    await meter({ ...video, id: id("released"), status: "failed", engineCostUsd: 0 });
    /* Failed after the vendor billed: charged, and said so. */
    await reserveGenerationSpend({ ...video, id: id("failed_paid"), status: "running", engineCostUsd: 1, createdBy: "u_editor" });
    await meter({ ...video, id: id("failed_paid"), status: "failed", engineCostUsd: 0.5 });
    /* On the workspace's own key: no credits, whatever the vendor charged. */
    await meter({ id: id("own_key"), kind: "image", engine: "openai", model: "gpt-image-2.5-flare", status: "succeeded", engineCostUsd: 0.0421, createdBy: "u_editor" });
    await platformDb().execute({ sql: "UPDATE meter_events SET paid_by_platform=0,billed_credits=0 WHERE id=?", args: [id("own_key")] });
  });
  const at = Date.now();
  /* A failed agent run as PR #398's `unbilled` meter event writes it: the vendor's cost kept, nothing billed. */
  await platformDb().execute({
    sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [id("agent_unbilled"), ws.id, "text", "vercel", "anthropic/claude-sonnet-4.6", "failed", 0.3512, 0, 1, "u_editor", at, at],
  });
  /* Last month, and a neighbour's job this minute: neither belongs on this month's page. */
  const earlier = lastMonthAt();
  for (const [key, workspaceId, when] of [["old_a", ws.id, earlier], ["old_b", ws.id, earlier + 60_000], ["neighbour", other.id, at]] as const)
    await platformDb().execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,'image','google','gemini-3.1-flash-image','succeeded',0.039,1,1,'u_editor',?,?)`,
      args: [id(key), workspaceId, when, when],
    });

  await runInTenant(ws, async () => {
    const all = inCredits(await usageLedgerPage(q(), admin("u_owner")));
    expect(all.unit).toBe("credits");
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(byId.get(id("neighbour"))).toBeUndefined();
    expect(all.rows).toHaveLength(8);
    expect(byId.get(id("held"))).toMatchObject({ state: "held", credits: 15, who: "Editor", engine: "Seedance 2.5", kind: "video" });
    expect(byId.get(id("settled"))).toMatchObject({ state: "charged", credits: 12 });
    expect(byId.get(id("released"))).toMatchObject({ state: "failed-not-billed", credits: 0 });
    expect(byId.get(id("failed_paid"))).toMatchObject({ state: "failed-charged", credits: 8 });
    expect(byId.get(id("own_key"))).toMatchObject({ state: "own-key", credits: 0 });
    expect(byId.get(id("agent_unbilled"))).toMatchObject({ state: "failed-not-billed", credits: 0, engine: expect.stringMatching(/^Atomik · /) });
    /* The whole answer is credits: no dollar field, figure or sign, not even the vendor's costs as numbers. */
    const wire = JSON.stringify(all);
    expect(wire).not.toMatch(/usd|\$|cost|margin/i);
    for (const vendorUsd of ["0.8", "0.5", "0.3512", "0.0421", "0.039"]) expect(wire).not.toContain(vendorUsd);
    /* Charged plus held is exactly what the balance has used. */
    const used = (await billingStateFor(ws.id)).credits.used;
    expect(all.totals).toEqual({ jobs: 8, charged: 12 + 8 + 2, held: 15, notBilled: 3 });
    expect(all.rows.reduce((sum, r) => sum + r.credits, 0)).toBe(used);
    expect(all.months).toEqual([monthOf(at), monthOf(earlier)]);

    /* One month; its totals are the month's alone. */
    const last = await usageLedgerPage(q(`&month=${monthOf(earlier)}`), admin("u_owner"));
    expect(last.rows.map((r) => r.id)).toEqual([id("old_b"), id("old_a")]);
    expect(last.totals).toEqual({ jobs: 2, charged: 2, held: 0, notBilled: 0 });
    const now = await usageLedgerPage(q(`&month=${monthOf(at)}`), admin("u_owner"));
    expect(now.rows).toHaveLength(6);

    /* Paged newest first on the server: every row once, in order, whatever the page size. */
    const seen: string[] = [];
    let page = await usageLedgerPage(q("&limit=3"), admin("u_owner"));
    expect(page.months).toBeDefined();
    seen.push(...page.rows.map((r) => r.id));
    while (page.next) {
      page = await usageLedgerPage(q(`&limit=3&cursor=${page.next}`), admin("u_owner"));
      expect(page.months).toBeUndefined();
      seen.push(...page.rows.map((r) => r.id));
    }
    expect(seen).toEqual(all.rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(8);

    /* One job, for the Inspector — and only this workspace's. */
    expect((await usageLedgerPage(q(`&id=${id("held")}`), admin("u_owner"))).rows.map((r) => r.state)).toEqual(["held"]);
    expect((await usageLedgerPage(q(`&id=${id("neighbour")}`), admin("u_owner"))).rows).toEqual([]);

    /* Everyone's spend by person is the owners' and admins': a member reads every job, and a name only on their own. */
    const member = inCredits(await usageLedgerPage(q(), { id: "u_producer", admin: false }));
    expect(member.rows.map((r) => r.credits)).toEqual(all.rows.map((r) => r.credits));
    expect(new Set(member.rows.map((r) => r.who))).toEqual(new Set(["Teammate"]));
    expect(JSON.stringify(member)).not.toContain("Editor");
    const author = await usageLedgerPage(q(), { id: "u_editor", admin: false });
    expect(new Set(author.rows.map((r) => r.who))).toEqual(new Set(["Editor"]));

    /* The file: the same rows, in credits. */
    const csv = ledgerCsv(all);
    expect(csv.split("\r\n")[0]).toBe("date,time_utc,who,engine,kind,status,credits");
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(9);
    expect(csv).toContain("Failed · not billed");
    expect(csv).not.toMatch(/usd|\$/i);
    const response = await usageLedgerResponse(new Request(`http://local/api/usage?rows=1&format=csv&month=${monthOf(at)}`), admin("u_editor"));
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="usage-${ws.slug}-${monthOf(at)}.csv"`);
    const file = await response.text();
    expect(file.split("\r\n").filter(Boolean)).toHaveLength(7);
    expect(file).not.toMatch(/usd|\$/i);
    expect((await usageLedgerResponse(new Request("http://local/api/usage?rows=1&month=26-9"), admin("u_editor"))).status).toBe(400);
    /* A member's file carries no teammate's name either. */
    const memberFile = await (await usageLedgerResponse(new Request("http://local/api/usage?rows=1&format=csv"), { id: "u_producer", admin: false })).text();
    expect(memberFile).not.toContain("Editor");
    expect(memberFile).toContain("Teammate");
  });
});

test("a migrated workspace never invents a historical credit charge from vendor costs", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { usageLedgerPage, parseLedgerQuery, ledgerCsv } = await import("../../lib/usageLedger");
  const ws = workspace("dollars", false);
  const q = (s = "") => parseLedgerQuery(new URLSearchParams(`rows=1${s}`)) as Exclude<ReturnType<typeof parseLedgerQuery>, { error: string }>;
  await runInTenant(ws, async () => {
    const { db, ready } = await import("../../lib/db");
    await ready();
    await db().execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u_producer','producer@example.test','Producer','x','admin',0)" });
    const gen = "INSERT INTO generations(id,model,prompt,params,status,kind,provider,cost_usd,refine_cost_usd,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";
    const t = Date.now();
    const rows: [string, string, string, number | null, number | null, number][] = [
      ["d_charged", "{}", "succeeded", 1.25, 0.05, t - 1000],
      ["d_failed", "{}", "failed", null, null, t - 2000],
      ["d_cancelled", "{}", "cancelled", 0, null, t - 3000],
      ["d_running", "{}", "running", null, null, t - 4000],
      ["d_held", "{}", "held", null, null, t - 5000],
      ["d_unpriced", "{}", "succeeded", null, null, t - 6000],
      ["d_connected", JSON.stringify({ consumerCreditUnit: "higgsfield_credits", consumerCredits: 75 }), "succeeded", null, null, t - 7000],
      [`gen_hfc_${"a".repeat(40)}`, "{}", "succeeded", null, null, t - 8000],
      /* The starter production's demo take: a price on paper, nobody rendered or paid for it. */
      ["d_demo", JSON.stringify({ demo: true }), "succeeded", 2.5, null, t - 9000],
    ];
    for (const [key, params, status, cost, refine, at] of rows)
      await db().execute({ sql: gen, args: [key, "dreamina-seedance-2-5-260628", "a harbour", params, status, "video", "byteplus", cost, refine, "u_producer", at, at] });
    const page = await usageLedgerPage(q(), admin("u_producer"));
    expect(page.unit).toBe("credits");
    expect(page.rows).toEqual([]); // No historical Particl ledger entries were recorded.
    expect(JSON.stringify(page)).not.toMatch(/"usd"|"costUsd"/);
    expect(ledgerCsv(page).split("\r\n")[0]).toBe("date,time_utc,who,engine,kind,status,credits");
  });
});

test("the connected account is the viewer's own jobs, in the provider's credits as quoted", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { connectedLedgerPage, parseLedgerQuery, ledgerCsv } = await import("../../lib/usageLedger");
  const { consumerJobsReady } = await import("../../lib/higgsfield-consumer/jobs");
  const ws = workspace("connected", true);
  const q = parseLedgerQuery(new URLSearchParams("rows=connected")) as Exclude<ReturnType<typeof parseLedgerQuery>, { error: string }>;
  await runInTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    await consumerJobsReady();
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('u_me:draft_a','u_me','draft_a','Bottle campaign','{}',1,0)" });
    const job = `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const t = Date.now();
    const jobs: [string, string, string, string, number, string | null, number][] = [
      ["j_done", "u_me", "generation", "completed", 75, "claim", t - 1000],
      ["j_failed", "u_me", "marketing-video", "failed", 150, "claim", t - 2000],
      ["j_open", "u_me", "genjutsu", "accepted", 40.5, "claim", t - 3000],
      ["j_quoted", "u_me", "generation", "quoted", 999, null, t - 4000],
      ["j_unclaimed", "u_me", "generation", "uncertain", 888, null, t - 5000],
      ["j_teammate", "u_other", "generation", "completed", 500, "claim", t - 500],
    ];
    for (const [key, user, workflow, status, credits, claim, at] of jobs)
      await db().execute({ sql: job, args: [id(key), user, "draft_a", "owner", "gen", workflow, `k_${key}`, "{}", "h", "h", credits, t + 60_000, "[]", status, claim, at, at] });
    const page = await connectedLedgerPage("u_me", q);
    expect(page).toMatchObject({ unit: "higgsfield_credits", basis: "approved_quotes", scope: "own_account" });
    expect(page.rows.map((r) => [r.id, r.state, r.quotedCredits])).toEqual([
      [id("j_done"), "completed", 75], [id("j_failed"), "failed", 150], [id("j_open"), "pending", 40.5],
    ]);
    expect(page.rows[0]).toMatchObject({ workflow: "Generation", project: "Bottle campaign" });
    expect(page.totals).toEqual({ jobs: 3, quoted: 265.5 });
    expect(JSON.stringify(page)).not.toMatch(/usd|\$/i);
    expect(ledgerCsv(page).split("\r\n")[0]).toBe("date,time_utc,workflow,project,status,connected_credits_quoted");
  });
});
