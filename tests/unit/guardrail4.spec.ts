import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { JOB_APPROVAL_LINE_USD, jobApprovalLineCredits, jobLineVerdict } from "../../lib/approvalRule";
import { quoteOf, verdictOf, type Context, type Unit } from "../../lib/quote";
import { alignLedgerUnit } from "../helpers/ledgerUnit";

/**
 * Pricing guardrail 4 (SOW §7A): any single job estimated above the platform's approval line (JOB_APPROVAL_LINE_USD, 200 cr at a credit's
 * US$0.10) needs the workspace's cost approval rule to fire, whatever the workspace's own setting: an admin's own tap clears it, a member
 * is told an admin must start it, and an API token, an MCP client or Atomik is refused outright. Mocked providers only: no engine is called,
 * no credit is spent; real temporary databases for the reservation.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-guardrail-4-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const workspace = (name: string): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null,
  flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null });
const person = (id: string, role: "admin" | "member"): TenantUser => ({ id, email: `${id}@example.test`, name: id, role, owner: role === "admin", disabled: false, lastSeen: null, createdAt: 0 });
const LINE = jobApprovalLineCredits(0.1);
/* Ids and workspace names are this run's own: another spec in the same worker may share the databases, and a job id belongs to one workspace. */
test.beforeAll(async () => { await alignLedgerUnit(); });
const run = Math.random().toString(36).slice(2, 8);

test("the line is JOB_APPROVAL_LINE_USD at the price of a credit: 200 cr at $0.10, and it moves with the price", () => {
  expect(JOB_APPROVAL_LINE_USD).toBe(20);
  expect(LINE).toBe(200);
  expect(jobApprovalLineCredits(0.2)).toBe(100);
  expect(jobApprovalLineCredits(0.05)).toBe(400);
});

test("the verdict: under or exactly at the line nothing changes; over it a member is refused, an admin clears it, a machine is refused whoever it acts for", () => {
  const ok = { blocked: false, line: "" };
  for (const credits of [0, 1, 199.9, 200]) for (const [isAdmin, machine] of [[false, false], [true, false]] as const)
    expect(jobLineVerdict({ credits, lineCredits: LINE, isAdmin, machine }), `${credits} ${isAdmin}`).toEqual(ok);
  const member = jobLineVerdict({ credits: 200.1, lineCredits: LINE, isAdmin: false, machine: false });
  expect(member.blocked).toBe(true);
  expect(member.line).toMatch(/over the 200 cr that needs an admin\. An admin has to start it\./);
  expect(jobLineVerdict({ credits: 240, lineCredits: LINE, isAdmin: true, machine: false })).toEqual(ok);
  for (const isAdmin of [false, true]) {
    const machine = jobLineVerdict({ credits: 201, lineCredits: LINE, isAdmin, machine: true });
    expect(machine.blocked, `machine, admin ${isAdmin}`).toBe(true);
    expect(machine.line).toMatch(/needs an admin's own tap\. Atomik, an MCP client and API tokens can prepare it, never start it\./);
  }
  /* A machine under the line is not stopped by this guardrail. */
  expect(jobLineVerdict({ credits: 150, lineCredits: LINE, isAdmin: false, machine: true })).toEqual(ok);
  /* The house is never worded in credits. */
  expect(jobLineVerdict({ credits: 300, lineCredits: LINE, isAdmin: false, machine: false, figures: false }).line).not.toMatch(/\bcr\b|\d/);
  expect(jobLineVerdict({ credits: 300, lineCredits: LINE, isAdmin: false, machine: true, figures: false }).line).not.toMatch(/\bcr\b|\d/);
});

const base: Context = { balance: 10_000, allowance: null, caps: {}, warnPct: 80, rule: "anyone", shotCap: 50, isAdmin: false };
const unit = (usd: number, key = "s1"): Unit => ({ key, usd, engine: "dreamina-seedance-2-5-260628", spent: 0, code: "SH010", projectId: null, platformPays: true });

/** The dollars of an engine cost that price at about `credits` (the quote's own pricing, margin and rounding included). */
function usdFor(credits: number): number {
  let usd = credits * 0.1;
  for (let i = 0; i < 12; i++) usd *= credits / quoteOf([unit(usd)]).totalCredits;
  return usd;
}

test("the quote: a member over the line is stopped whatever the rule and shot; an admin is not; a machine is; under the line is unchanged; takes multiply first", () => {
  const line = { credits: LINE, machine: false };
  const big = quoteOf([unit(usdFor(250))]);
  expect(big.totalCredits).toBeGreaterThan(LINE);
  /* Any rule, with or without a shot's cap: the member is refused. */
  for (const rule of ["anyone", "cap", "producer"] as const) {
    const v = verdictOf(big, { ...base, rule, jobLine: line });
    expect(v, rule).toMatchObject({ allow: false, gate: "approval" });
    expect(v.line).toMatch(/An admin has to start it\./);
  }
  /* An admin's own tap clears it. */
  expect(verdictOf(big, { ...base, isAdmin: true, jobLine: line })).toMatchObject({ allow: true });
  /* A machine is refused outright, admin or not. */
  expect(verdictOf(big, { ...base, isAdmin: true, jobLine: { credits: LINE, machine: true } })).toMatchObject({ allow: false, gate: "approval" });
  /* Under the line, unchanged: with and without the line in the context the verdict is the same. */
  const under = quoteOf([unit(usdFor(150))]);
  expect(under.totalCredits).toBeLessThan(LINE);
  expect(verdictOf(under, { ...base, jobLine: line })).toEqual(verdictOf(under, base));
  expect(verdictOf(under, { ...base, jobLine: { credits: LINE, machine: true } })).toEqual(verdictOf(under, base));
  /* A line that stands for several takes is compared as a whole, the takes multiplied first: one take of ~70 cr passes, four of them are ~280 cr as one. */
  const one = quoteOf([unit(usdFor(70))]);
  expect(one.totalCredits).toBeLessThan(LINE);
  expect(verdictOf(one, { ...base, jobLine: line }).allow).toBe(true);
  const batch = quoteOf([{ ...unit(usdFor(70)), count: 4 }]);
  expect(batch.lines[0].count).toBe(4);
  expect(batch.totalCredits).toBeGreaterThan(LINE);
  expect(verdictOf(batch, { ...base, jobLine: line })).toMatchObject({ allow: false, gate: "approval" });
  expect(verdictOf(batch, { ...base, isAdmin: true, jobLine: line }).allow).toBe(true);
  /* Without the line in the context (a caller that does not judge it) nothing changes. */
  expect(verdictOf(big, base).allow).toBe(true);
});

/** A paid job whose bill is well over, or well under, the line. */
async function costs() {
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const per = creditsAtTerms(1, currentBillingTerms("video", "mock"));
  return { over: (250 / per) * 1, under: (120 / per) * 1 };
}
const event = (id: string, engineCostUsd: number, extra: Record<string, unknown> = {}) => ({ id, kind: "video" as const, engine: "byteplus", model: "mock", status: "running" as const, engineCostUsd, ...extra });

test("the reservation: a member over the line is refused (403, nothing reserved); an admin is not; a token or an agent is refused outright; under the line is unchanged", async () => {
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  await platformReady();
  /* One funded workspace for each case, so no job slot (the workspace's concurrency) is spent by another case. */
  const funded = async (name: string) => {
    const ws = workspace(`line_${name}_${run}`);
    await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_line_${name}_${run}`, ws.id, 100_000, "Test", 0] });
    return ws;
  };
  const { over, under } = await costs();
  const reserved = async (id: string) => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=?", args: [id] })).rows[0].n);
  const refusal = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return e as InstanceType<typeof SpendReservationError>; } return null; };
  const as = (user: TenantUser | null, extra: { token?: { id: string; name: string; scope: "render" | "prepare"; capUsd: number | null } } = {}) => ({ user, ...extra });

  await runInTenant(await funded("member"), async () => {
    await ready();
    /* A member, whatever the rule (the default is "anyone") and with or without a shot: refused, 403, nothing reserved. */
    const noShot = await refusal(() => reserveGenerationSpend(event(`gen_member_a_${run}`, over)));
    expect(noShot).toBeInstanceOf(SpendReservationError);
    expect(noShot).toMatchObject({ status: 403 });
    expect(noShot!.message).toMatch(/An admin has to start it\./);
    expect(await reserved(`gen_member_a_${run}`)).toBe(0);
  }, as(person("u_member", "member")));
  await runInTenant(await funded("member2"), async () => {
    const withShot = await refusal(() => reserveGenerationSpend(event(`gen_member_b_${run}`, over, { shotId: "shot_x" })));
    expect(withShot).toMatchObject({ status: 403 });
    expect(await reserved(`gen_member_b_${run}`)).toBe(0);
    /* Under the line the same member reserves as ever. */
    await reserveGenerationSpend(event(`gen_member_c_${run}`, under));
    expect(await reserved(`gen_member_c_${run}`)).toBe(1);
  }, as(person("u_member", "member")));
  /* An admin's own tap clears it. */
  await runInTenant(await funded("admin"), async () => {
    await reserveGenerationSpend(event(`gen_admin_a_${run}`, over));
    expect(await reserved(`gen_admin_a_${run}`)).toBe(1);
  }, as(person("u_admin", "admin")));
  /* A token, admin's or not, is refused outright; so is an agent identity acting under an admin's session. */
  await runInTenant(await funded("token"), async () => {
    const t = await refusal(() => reserveGenerationSpend(event(`gen_token_a_${run}`, over), { token: { id: "tok1", capUsd: null, capCredits: null } }));
    expect(t?.message).toMatch(/never start it/);
    expect(t).toMatchObject({ status: 403 });
    expect(t!.message).toMatch(/Atomik, an MCP client and API tokens can prepare it, never start it\./);
    const a = await refusal(() => reserveGenerationSpend(event(`gen_agent_a_${run}`, over, { createdBy: "agent:run_1" })));
    expect(a).toMatchObject({ status: 403 });
    expect(await reserved(`gen_token_a_${run}`) + await reserved(`gen_agent_a_${run}`)).toBe(0);
    /* A machine under the line is not stopped by this guardrail. */
    await reserveGenerationSpend(event(`gen_token_b_${run}`, under), { token: { id: "tok1", capUsd: null, capCredits: null } });
    expect(await reserved(`gen_token_b_${run}`)).toBe(1);
  }, as(person("u_admin", "admin"), { token: { id: "tok1", name: "agent", scope: "render", capUsd: null } }));
  /* A held take's release decides from its author: an admin author's clears it, a member author's does not. */
  await runInTenant(await funded("held"), async () => {
    await reserveGenerationSpend(event(`gen_held_admin_${run}`, over, { createdBy: "u_admin" }), { adminTap: true });
    expect(await reserved(`gen_held_admin_${run}`)).toBe(1);
    const m = await refusal(() => reserveGenerationSpend(event(`gen_held_member_${run}`, over, { createdBy: "u_member" }), { adminTap: false }));
    expect(m?.message).toMatch(/An admin has to start it/);
    expect(m).toMatchObject({ status: 403 });
    expect(await reserved(`gen_held_member_${run}`)).toBe(0);
  }, as(null));
});

test("before a take is parked or sent (admission): the same words, the hold counts, and a member's over-line take is told at the press, never parked", async () => {
  const { jobLineGate } = await import("../../lib/shotCap");
  const { runInTenant } = await import("../../lib/tenant");
  const { over, under } = await costs();
  await runInTenant(workspace(`gate_${run}`), async () => {
    const member = { isAdmin: false, machine: false, modelId: "mock", paid: true };
    expect(jobLineGate({ takeUsd: over, ...member })).toMatch(/An admin has to start it\./);
    expect(jobLineGate({ takeUsd: under, ...member })).toBeNull();
    expect(jobLineGate({ takeUsd: over, ...member, isAdmin: true })).toBeNull();
    expect(jobLineGate({ takeUsd: over, ...member, isAdmin: true, machine: true })).toMatch(/never start it\./);
    expect(jobLineGate({ takeUsd: under, ...member, machine: true })).toBeNull();
    /* A take that holds its ceiling counts at its hold: under the line at its estimate, over it at three times that. */
    expect(jobLineGate({ takeUsd: under * 0.7, ...member })).toBeNull();
    expect(jobLineGate({ takeUsd: under * 0.7, ...member, band: 3 })).toMatch(/An admin has to start it\./);
  });
});

test("own-key work is not judged: a quote line the platform does not pay for, and an admission gate told it is not paid", async () => {
  const { jobLineGate } = await import("../../lib/shotCap");
  const { runInTenant } = await import("../../lib/tenant");
  const { over } = await costs();
  const free = quoteOf([{ ...unit(usdFor(300)), platformPays: false }]);
  expect(free.totalCredits).toBeGreaterThan(LINE);
  expect(verdictOf(free, { ...base, jobLine: { credits: LINE, machine: false } })).toMatchObject({ allow: true });
  expect(verdictOf(free, { ...base, jobLine: { credits: LINE, machine: true } })).toMatchObject({ allow: true });
  await runInTenant(workspace(`own_${run}`), async () => {
    expect(jobLineGate({ takeUsd: over, modelId: "mock", paid: false, isAdmin: false, machine: false })).toBeNull();
    expect(jobLineGate({ takeUsd: over, modelId: "mock", paid: true, isAdmin: false, machine: false })).not.toBeNull();
  });
});

test("the reservation at the line: exactly 200 cr is allowed, 201 cr is refused; an own-key (house) job over it is not judged", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  await platformReady();
  const terms = currentBillingTerms("video", "mock");
  const per = creditsAtTerms(1000, terms) / 1000;
  const costFor = (credits: number) => { let usd = (credits - 0.5) / per; for (let i = 0; i < 20 && creditsAtTerms(usd, terms) !== credits; i++) usd *= credits / creditsAtTerms(usd, terms); return usd; };
  const [at200, at201] = [costFor(200), costFor(201)];
  expect(creditsAtTerms(at200, terms)).toBe(200);
  expect(creditsAtTerms(at201, terms)).toBe(201);
  for (const [name, usd, allowed] of [["at200", at200, true], ["at201", at201, false]] as const) {
    const ws = workspace(`${name}_${run}`);
    await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_${name}_${run}`, ws.id, 100_000, "Test", 0] });
    await runInTenant(ws, async () => {
      await ready();
      const attempt = reserveGenerationSpend(event(`gen_${name}_${run}`, usd));
      if (allowed) await attempt; else await expect(attempt).rejects.toMatchObject({ status: 403 });
    }, { user: person("u_member", "member") });
  }
  /* The house pays no credits: its jobs are not judged, member or not, token or not. */
  const house = { ...workspace(`house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false };
  await runInTenant(house, async () => {
    await ready();
    await reserveGenerationSpend(event(`gen_house_${run}`, over_(at201)));
  }, { user: person("u_member", "member") });
});
const over_ = (usd: number) => usd * 4;

test("no actor: a reservation with nobody behind it is refused over the line unless its caller marks it a continuation; a known author is judged as themselves", async () => {
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  await platformReady();
  const { over } = await costs();
  const funded = async (name: string) => {
    const ws = workspace(`noactor_${name}_${run}`);
    await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_noactor_${name}_${run}`, ws.id, 100_000, "Test", 0] });
    return ws;
  };
  /* Nobody signed in, no token, no agent, no author. */
  await runInTenant(await funded("a"), async () => {
    await ready();
    await expect(reserveGenerationSpend(event(`gen_noactor_a_${run}`, over))).rejects.toBeInstanceOf(SpendReservationError);
    await expect(reserveGenerationSpend(event(`gen_noactor_a_${run}`, over))).rejects.toMatchObject({ status: 403 });
    /* Marked a continuation of a request admission judged: allowed. */
    await reserveGenerationSpend(event(`gen_noactor_b_${run}`, over), { continuation: true });
  }, { user: null });
  /* A known author with nobody signed in is judged as themselves: the workspace's owner clears it, another person does not. */
  await runInTenant(await funded("b"), async () => {
    await ready();
    await reserveGenerationSpend(event(`gen_author_owner_${run}`, over, { createdBy: "u_test" }));
    await expect(reserveGenerationSpend(event(`gen_author_other_${run}`, over, { createdBy: "u_someone" }))).rejects.toMatchObject({ status: 403 });
  }, { user: null });
});

test("Atomik's Auto: a step it approved itself is a machine at the reservation, however high the Auto line is raised", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  await platformReady();
  const { over } = await costs();
  const ws = workspace(`auto_${run}`);
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_auto_${run}`, ws.id, 100_000, "Test", 0] });
  await runInTenant(ws, async () => {
    await ready();
    const spend = { id: `run_auto_${run}`, limitCredits: 1_000_000, band: 1 };
    /* The owner's own tap (a person approved the step): an admin's job over the line goes. */
    await reserveGenerationSpend(event(`gen_auto_tap_${run}`, over), { run: spend });
    /* The same job, approved by Auto: refused outright, admin session or not. */
    const refused = await reserveGenerationSpend(event(`gen_auto_job_${run}`, over), { run: { ...spend, auto: true } }).then(() => null, (e: Error) => e);
    expect(refused).toMatchObject({ status: 403 });
    expect(refused!.message).toMatch(/never start it/);
  }, { user: person("u_admin", "admin") });
});

test("held takes released through releaseHeldJobs: the author's standing, or an admin pressing Release, decides; a member's over-line take is not started by someone else's poll", async () => {
  const { releaseHeldJobs, heldInfo } = await import("../../lib/held");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  const ws = workspace(`held_${run}`);
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_held_${run}`, ws.id, 100_000, "Test", Date.now()] });
  for (const [who, role] of [["u_held_admin", "admin"], ["u_held_member", "member"]] as const)
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, `${who}_${run}`, role] });
  const heldRow = async (id: string, by: string) => db().execute({
    sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
          VALUES(?,?,?,?,'test',?,'held',?,?,?,?,'generate')`,
    args: [id, "video", "byteplus", "dreamina-seedance-2-0-260128", JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, held: { ...heldInfo(60, "video", "dreamina-seedance-2-0-260128", "slots"), at: 1 } }), by, Date.now(), Date.now(), "byteplus"],
  });
  const state = async (id: string) => String((await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0]?.status);
  const sent: string[] = [];
  const defer = (work: () => unknown) => { sent.push("deferred"); void work; };
  await runInTenant(ws, async () => {
    await ready();
    /* An admin's held take, released by a poll with nobody signed in: its author is an admin, so it goes. */
    await heldRow(`gen_held_a_${run}`, `u_held_admin_${run}`);
    const first = await releaseHeldJobs({ defer });
    expect(first, JSON.stringify(first)).toMatchObject({});
    expect(await state(`gen_held_a_${run}`), JSON.stringify(first)).not.toBe("held");
    /* A member's held take, released by the same kind of poll: not started (their standing, not the poll's). */
    await heldRow(`gen_held_m_${run}`, `u_held_member_${run}`);
    const polled = await releaseHeldJobs({ defer });
    expect(polled.released).not.toContain(`gen_held_m_${run}`);
    expect(await state(`gen_held_m_${run}`)).not.toBe("running");
  }, { user: null });
  /* An admin pressing Release on the member's take starts it: the presser's tap. */
  await runInTenant(ws, async () => {
    await heldRow(`gen_held_p_${run}`, `u_held_member_${run}`);
    const pressed = await releaseHeldJobs({ defer, only: `gen_held_p_${run}` });
    expect(pressed.released).toContain(`gen_held_p_${run}`);
  }, { user: person("u_presser", "admin") });
});

test("audio, dubbing and text quotes: the same words at the quote, for a member and for a machine, and none for an admin or under the line", async () => {
  const { jobLineNow } = await import("../../lib/shotCap");
  const { paidTextQuoteResponse } = await import("../../lib/paidText");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace(`quotes_${run}`);
  await runInTenant(ws, async () => { expect(jobLineNow(300)).toMatch(/An admin has to start it\./); expect(jobLineNow(150)).toBeNull(); },
    { user: person("u_member", "member") });
  await runInTenant(ws, async () => { expect(jobLineNow(300)).toBeNull(); }, { user: person("u_admin", "admin") });
  await runInTenant(ws, async () => { expect(jobLineNow(300)).toMatch(/never start it\./); expect(jobLineNow(150)).toBeNull(); },
    { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render", capUsd: null } });
  await runInTenant(ws, async () => { expect(jobLineNow(300)).toMatch(/never start it\./); }, { user: person("agent:run_1", "admin") });
  /* A text quote over the line is refused with needsAdmin; under it, the quote is as ever. */
  const quote = (credits: number) => ({ model: "m", effort: "auto", estimateCredits: credits, estimateUsd: credits / 10 });
  await runInTenant(ws, async () => {
    const refused = paidTextQuoteResponse(quote(300));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ needsAdmin: true });
    expect(paidTextQuoteResponse(quote(150)).status).toBe(200);
  }, { user: person("u_member", "member") });
  await runInTenant(ws, async () => { expect(paidTextQuoteResponse(quote(300)).status).toBe(200); }, { user: person("u_admin", "admin") });
});

test("the quote's context: a token's quote is a machine's, an agent's too, a person's is not; so the quote and the press agree", async () => {
  const { contextFor } = await import("../../lib/impact");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const big = quoteOf([unit(usdFor(250))]);
  const ws = workspace(`ctx_${run}`);
  await runInTenant(ws, async () => {
    await ready();
    const person_ = await contextFor([], { isAdmin: true });
    expect(person_.jobLine).toEqual({ credits: LINE, machine: false });
    expect(verdictOf(big, person_).allow).toBe(true);
  }, { user: person("u_admin", "admin") });
  await runInTenant(ws, async () => {
    await ready();
    /* A token that carries an admin's identity (GET /api/rig/bindings/[id] answers it this): refused, as the press would. */
    const ctx = await contextFor([], { isAdmin: true });
    expect(ctx.jobLine).toEqual({ credits: LINE, machine: true });
    expect(verdictOf(big, ctx)).toMatchObject({ allow: false, gate: "approval" });
  }, { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render", capUsd: null } });
  await runInTenant(ws, async () => {
    await ready();
    expect((await contextFor([], { isAdmin: false })).jobLine?.machine).toBe(true);
  }, { user: person("agent:run_2", "member") });
});

test("dubbing refuses before the dub take or its job row is written, so no failed take is left in the Library; audio before its claim; both at the quote", async () => {
  const { readFileSync } = await import("node:fs");
  const dub = readFileSync("lib/dubbing.ts", "utf8");
  expect(dub.indexOf("jobLineNow(estimatedCredits)"), "dubbing judges the line").toBeGreaterThan(0);
  expect(dub.indexOf("jobLineNow(estimatedCredits)")).toBeLessThan(dub.indexOf("if (quoteOnly)"));
  expect(dub.indexOf("jobLineNow(estimatedCredits)")).toBeLessThan(dub.indexOf("INSERT INTO generations"));
  expect(dub.indexOf("jobLineNow(estimatedCredits)")).toBeLessThan(dub.indexOf("claimBinding("));
  const audio = readFileSync("lib/audioAdmission.ts", "utf8");
  expect(audio.indexOf("jobLineNow(estimatedCredits)"), "audio judges the line").toBeGreaterThan(0);
  expect(audio.indexOf("jobLineNow(estimatedCredits)")).toBeLessThan(audio.indexOf("if (quoteOnly)"));
});
