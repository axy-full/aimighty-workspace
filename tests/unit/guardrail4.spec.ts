import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { JOB_APPROVAL_LINE_USD, jobApprovalLineCredits, jobLineVerdict } from "../../lib/approvalRule";
import { quoteOf, verdictOf, type Context, type Unit } from "../../lib/quote";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { keepingHouseJobsClean } from "../helpers/houseJobs";

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
    const member = { isAdmin: false, machine: false, modelId: "mock", key: "ark" as const };
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

test("work the platform does not pay for is not judged at the quote; the house is judged at cost at the quote, the press and the reservation, worded without a figure", async () => {
  const { jobLineGate } = await import("../../lib/shotCap");
  const { runInTenant } = await import("../../lib/tenant");
  const free = quoteOf([{ ...unit(usdFor(300)), platformPays: false }]);
  expect(free.totalCredits).toBeGreaterThan(LINE);
  expect(verdictOf(free, { ...base, jobLine: { credits: LINE, machine: false } })).toMatchObject({ allow: true });
  expect(verdictOf(free, { ...base, jobLine: { credits: LINE, machine: true } })).toMatchObject({ allow: true });
  /* The house, at the quote: its line is the engine's dollars at the price of a credit, no margin. $25 is 250 cr at cost, $15 is 150. */
  const house = { ...base, jobLine: { credits: LINE, machine: false, house: true, perCredit: 0.1 } };
  const big = quoteOf([{ ...unit(25), platformPays: false }]);
  const small = quoteOf([{ ...unit(15), platformPays: false }]);
  const member = verdictOf(big, house);
  expect(member).toMatchObject({ allow: false, gate: "approval" });
  expect(member.line).not.toMatch(/\bcr\b|\d/);
  expect(verdictOf(big, { ...house, isAdmin: true })).toMatchObject({ allow: true });
  expect(verdictOf(big, { ...house, isAdmin: true, jobLine: { ...house.jobLine, machine: true } })).toMatchObject({ allow: false, gate: "approval" });
  expect(verdictOf(small, house)).toEqual(verdictOf(small, base));
  expect(verdictOf(small, { ...house, jobLine: { ...house.jobLine, machine: true } })).toEqual(verdictOf(small, base));
  /* The press (admission), in the house: the same words and none of the figures; the hold counts; an admin clears it; a machine never. */
  const houseWs = { ...workspace(`gate_house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  await runInTenant(houseWs, async () => {
    const m = { isAdmin: false, machine: false, modelId: "mock", key: "ark" as const };
    const refused = jobLineGate({ takeUsd: 25, ...m });
    expect(refused).toMatch(/An admin has to start it\./);
    expect(refused).not.toMatch(/\bcr\b|\d/);
    expect(jobLineGate({ takeUsd: 15, ...m })).toBeNull();
    expect(jobLineGate({ takeUsd: 15, ...m, band: 2 })).not.toBeNull();
    expect(jobLineGate({ takeUsd: 25, ...m, isAdmin: true })).toBeNull();
    expect(jobLineGate({ takeUsd: 25, ...m, isAdmin: true, machine: true })).toMatch(/never start it\./);
    expect(jobLineGate({ takeUsd: 15, ...m, machine: true })).toBeNull();
  });
});

test("the reservation at the line: exactly 200 cr is allowed, 201 cr is refused; the house is judged at cost", async () => {
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
  /* The house is judged at cost: $25 is 250 cr at no margin, $15 is 150. A member needs an admin, an admin's tap clears it, a token is refused outright, under the line is unchanged. */
  /* The house's job slots and hourly count are shared by every unit file in the worker (its id is fixed): this fixture states its own generous limits, so a refusal here is guardrail 4's and never a slot's. */
  const house = { ...workspace(`house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { return e as Error & { status?: number }; } return null; };
  await keepingHouseJobsClean(async () => {
    await runInTenant(house, async () => {
      await ready();
      const m = await refusal(() => reserveGenerationSpend(event(`gen_house_m_${run}`, 25)));
      expect(m).toMatchObject({ status: 403 });
      expect(m!.message).toMatch(/An admin has to start it\./);
      expect(m!.message).not.toMatch(/\bcr\b|\d/);
      await reserveGenerationSpend(event(`gen_house_u_${run}`, 15));
      const t = await refusal(() => reserveGenerationSpend(event(`gen_house_t_${run}`, 25), { token: { id: "tok_h", capUsd: null, capCredits: null } }));
      expect(t).toMatchObject({ status: 403 });
      expect(t!.message).toMatch(/never start it/);
      const a = await refusal(() => reserveGenerationSpend(event(`gen_house_a_${run}`, 25, { createdBy: "agent:run_9" })));
      expect(a).toMatchObject({ status: 403 });
    }, { user: person("u_member", "member") });
    await runInTenant(house, async () => {
      await ready();
      await reserveGenerationSpend(event(`gen_house_admin_${run}`, 25));
    }, { user: person("u_admin", "admin") });
  });
});

test("one press is one job at the reservation: a press of 4 x 60 cr from a member is refused with nothing reserved; an admin's is allowed; a token's is refused; a single 60 cr take is unchanged; a press that sums to exactly 200 cr is allowed, 201 cr is not", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  await platformReady();
  const terms = currentBillingTerms("video", "mock");
  const per = creditsAtTerms(1000, terms) / 1000;
  const costFor = (credits: number) => { let usd = (credits - 0.5) / per; for (let i = 0; i < 20 && creditsAtTerms(usd, terms) !== credits; i++) usd *= credits / creditsAtTerms(usd, terms); return usd; };
  const funded = async (name: string) => {
    const ws = workspace(`press_${name}_${run}`);
    await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_press_${name}_${run}`, ws.id, 100_000, "Test", 0] });
    return ws;
  };
  const reserved = async (id: string) => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=?", args: [id] })).rows[0].n);
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { return e as Error & { status?: number }; } return null; };
  const batch = (name: string, size: number) => ({ id: `b_${name}${run}`, size });
  const sixty = costFor(60);
  expect(creditsAtTerms(sixty, terms)).toBe(60);
  /* A member: the first take of 4 x 60 = 240 cr is refused, so are the others, and nothing is reserved for any of them. */
  await runInTenant(await funded("member"), async () => {
    await ready();
    for (let n = 1; n <= 4; n++) {
      const e = await refusal(() => reserveGenerationSpend(event(`gen_press_m${n}_${run}`, sixty), { batch: batch("m", 4) }));
      expect(e, `take ${n}`).toMatchObject({ status: 403 });
      expect(e!.message).toMatch(/An admin has to start it\./);
      expect(await reserved(`gen_press_m${n}_${run}`), `take ${n}`).toBe(0);
    }
    /* A single 60 cr take, and a press of 3 (180 cr), are unchanged. */
    await reserveGenerationSpend(event(`gen_press_single_${run}`, sixty));
    expect(await reserved(`gen_press_single_${run}`)).toBe(1);
    await reserveGenerationSpend(event(`gen_press_three_${run}`, sixty), { batch: batch("t", 3) });
    expect(await reserved(`gen_press_three_${run}`)).toBe(1);
  }, { user: person("u_member", "member") });
  /* An admin's tap clears the press of 4; a token is refused outright. */
  await runInTenant(await funded("admin"), async () => {
    await ready();
    await reserveGenerationSpend(event(`gen_press_a1_${run}`, sixty), { batch: batch("a", 4) });
    expect(await reserved(`gen_press_a1_${run}`)).toBe(1);
  }, { user: person("u_admin", "admin") });
  await runInTenant(await funded("token"), async () => {
    await ready();
    const e = await refusal(() => reserveGenerationSpend(event(`gen_press_t1_${run}`, sixty), { batch: batch("k", 4), token: { id: "tok_press", capUsd: null, capCredits: null } }));
    expect(e).toMatchObject({ status: 403 });
    expect(e!.message).toMatch(/never start it/);
    expect(await reserved(`gen_press_t1_${run}`)).toBe(0);
  }, { user: person("u_admin", "admin"), token: { id: "tok_press", name: "agent", scope: "render", capUsd: null } });
  /* Exactly 200 cr as one press (4 x 50) is allowed; 201 cr (3 x 67) is not. */
  await runInTenant(await funded("edge"), async () => {
    await ready();
    const fifty = costFor(50);
    await reserveGenerationSpend(event(`gen_press_e200_${run}`, fifty), { batch: batch("e", 4) });
    expect(await reserved(`gen_press_e200_${run}`)).toBe(1);
    const e = await refusal(() => reserveGenerationSpend(event(`gen_press_e201_${run}`, costFor(67)), { batch: batch("f", 3) }));
    expect(e).toMatchObject({ status: 403 });
    expect(await reserved(`gen_press_e201_${run}`)).toBe(0);
  }, { user: person("u_member", "member") });
  /* The takes already reserved under the id count: after 2 x 60 cr, a third of 60 passes (180) and a fourth does not (240), though no size was named. */
  await runInTenant(await funded("acc"), async () => {
    await ready();
    const { db } = await import("../../lib/db");
    for (let n = 1; n <= 3; n++) {
      const id = `gen_press_acc${n}_${run}`;
      await reserveGenerationSpend(event(id, sixty), { batch: { id: `b_acc${run}`, size: 1 } });
      await db().execute({ sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,'t',?,'running','u_member',?,?)`,
        args: [id, "video", "byteplus", "mock", JSON.stringify({ batchId: `b_acc${run}` }), Date.now(), Date.now()] });
    }
    const e = await refusal(() => reserveGenerationSpend(event(`gen_press_acc4_${run}`, sixty), { batch: { id: `b_acc${run}`, size: 1 } }));
    expect(e).toMatchObject({ status: 403 });
    expect(await reserved(`gen_press_acc4_${run}`)).toBe(0);
  }, { user: person("u_member", "member") });
});

test("one press is one job in the house, at cost: 4 x $6 (60 cr at cost each) from a member is refused with nothing reserved; an admin's is allowed; a token's is refused; $5 x 4 (exactly $20) is allowed", async () => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  await platformReady();
  const house = { ...workspace(`press_house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  const reserved = async (id: string) => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=?", args: [id] })).rows[0].n);
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { return e as Error & { status?: number }; } return null; };
  await keepingHouseJobsClean(async () => {
    await runInTenant(house, async () => {
      await ready();
      for (let n = 1; n <= 4; n++) {
        const e = await refusal(() => reserveGenerationSpend(event(`gen_hpress_m${n}_${run}`, 6), { batch: { id: `b_hm${run}`, size: 4 } }));
        expect(e, `take ${n}`).toMatchObject({ status: 403 });
        expect(e!.message).toMatch(/An admin has to start it\./);
        expect(e!.message).not.toMatch(/\bcr\b|\d/);
        expect(await reserved(`gen_hpress_m${n}_${run}`), `take ${n}`).toBe(0);
      }
      /* A single $6 job, and a press of 4 x $5 (exactly the line), are unchanged. */
      await reserveGenerationSpend(event(`gen_hpress_single_${run}`, 6));
      await reserveGenerationSpend(event(`gen_hpress_edge_${run}`, 5), { batch: { id: `b_he${run}`, size: 4 } });
      expect(await reserved(`gen_hpress_edge_${run}`)).toBe(1);
      const t = await refusal(() => reserveGenerationSpend(event(`gen_hpress_t_${run}`, 6), { batch: { id: `b_ht${run}`, size: 4 }, token: { id: "tok_hp", capUsd: null, capCredits: null } }));
      expect(t).toMatchObject({ status: 403 });
      expect(await reserved(`gen_hpress_t_${run}`)).toBe(0);
    }, { user: person("u_member", "member") });
    await runInTenant(house, async () => {
      await ready();
      await reserveGenerationSpend(event(`gen_hpress_a_${run}`, 6), { batch: { id: `b_ha${run}`, size: 4 } });
      expect(await reserved(`gen_hpress_a_${run}`)).toBe(1);
    }, { user: person("u_admin", "admin") });
  });
});

test("a held Cinema Studio take counts at its band in its press's sum (its held estimate is the quote; its hold is three times that), a held ordinary take at its estimate", async () => {
  const { batchTally } = await import("../../lib/batchLine");
  const { heldInfo } = await import("../../lib/held");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformReady } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  await runInTenant(workspace(`heldband_${run}`), async () => {
    await ready();
    const id = `b_hb${run}`;
    const heldRow = (gen: string, model: string, usd: number) => db().execute({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,'t',?,'held','u_member',?,?)`,
      args: [gen, "video", "byteplus", model, JSON.stringify({ batchId: id, held: { ...heldInfo(usd, "video", model, "credits"), at: 1 } }), Date.now(), Date.now()],
    });
    await heldRow(`gen_hb_cinema_${run}`, "higgsfield-cinema-studio-4.0", 5);
    await heldRow(`gen_hb_plain_${run}`, "dreamina-seedance-2-0-260128", 4);
    const tally = await batchTally({ id, size: 2 });
    expect(tally.count).toBe(2);
    expect(tally.usd).toBeCloseTo(5 * 3 + 4, 6);
    /* Its credits were already at the band (heldInfo's `needs`). */
    expect(tally.credits).toBe(heldInfo(5, "video", "higgsfield-cinema-studio-4.0").needs + heldInfo(4, "video", "dreamina-seedance-2-0-260128").needs);
  }, { user: person("u_member", "member") });
});

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
  const at = (credits: number) => ({ credits, usd: credits / 10, key: "elevenlabs" as const });
  await runInTenant(ws, async () => { expect(jobLineNow(at(300))).toMatch(/An admin has to start it\./); expect(jobLineNow(at(150))).toBeNull(); },
    { user: person("u_member", "member") });
  await runInTenant(ws, async () => { expect(jobLineNow(at(300))).toBeNull(); }, { user: person("u_admin", "admin") });
  await runInTenant(ws, async () => { expect(jobLineNow(at(300))).toMatch(/never start it\./); expect(jobLineNow(at(150))).toBeNull(); },
    { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render", capUsd: null } });
  await runInTenant(ws, async () => { expect(jobLineNow(at(300))).toMatch(/never start it\./); }, { user: person("agent:run_1", "admin") });
  /* The house, judged at cost: $25 is over the line, $15 is not, and the words carry no figure. */
  const house = { ...workspace(`quotes_house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  await runInTenant(house, async () => {
    const refused = jobLineNow({ credits: 0, usd: 25, key: "elevenlabs" });
    expect(refused).toMatch(/An admin has to start it\./);
    expect(refused).not.toMatch(/\bcr\b|\d/);
    expect(jobLineNow({ credits: 0, usd: 15, key: "elevenlabs" })).toBeNull();
  }, { user: person("u_member", "member") });
  await runInTenant(house, async () => { expect(jobLineNow({ credits: 0, usd: 25, key: "elevenlabs" })).toBeNull(); }, { user: person("u_admin", "admin") });
  await runInTenant(house, async () => { expect(jobLineNow({ credits: 0, usd: 25, key: "elevenlabs" })).toMatch(/never start it\./); },
    { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render", capUsd: null } });
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
    expect(person_.jobLine).toEqual({ credits: LINE, machine: false, house: false, perCredit: 0.1 });
    expect(verdictOf(big, person_).allow).toBe(true);
  }, { user: person("u_admin", "admin") });
  await runInTenant(ws, async () => {
    await ready();
    /* A token that carries an admin's identity (GET /api/rig/bindings/[id] answers it this): refused, as the press would. */
    const ctx = await contextFor([], { isAdmin: true });
    expect(ctx.jobLine).toEqual({ credits: LINE, machine: true, house: false, perCredit: 0.1 });
    expect(verdictOf(big, ctx)).toMatchObject({ allow: false, gate: "approval" });
  }, { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render", capUsd: null } });
  await runInTenant(ws, async () => {
    await ready();
    expect((await contextFor([], { isAdmin: false })).jobLine?.machine).toBe(true);
  }, { user: person("agent:run_2", "member") });
  /* The house is judged at cost: its context says so, and a $25 line is refused for a member and passes for an admin, a $15 one for both. */
  const house = { ...workspace(`ctx_house_${run}`), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 };
  const houseQuote = (usd: number) => quoteOf([{ ...unit(usd), platformPays: false }]);
  await runInTenant(house, async () => {
    await ready();
    const ctx = await contextFor([], { isAdmin: false });
    expect(ctx.jobLine).toMatchObject({ house: true, perCredit: 0.1, machine: false });
    expect(verdictOf(houseQuote(25), ctx)).toMatchObject({ allow: false, gate: "approval" });
    expect(verdictOf(houseQuote(15), ctx).allow).toBe(true);
  }, { user: person("u_member", "member") });
  await runInTenant(house, async () => {
    await ready();
    expect(verdictOf(houseQuote(25), await contextFor([], { isAdmin: true })).allow).toBe(true);
  }, { user: person("u_admin", "admin") });
});

/** A stored audio original with a recorded length, as the dubbing spec seeds one (its bytes on disk are the fixture tone). */
async function seedLongSource(seconds: number) {
  const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { db } = await import("../../lib/db");
  const id = `g4dub${run}`;
  const uploads = path.join(repoRoot, ".data", "uploads");
  mkdirSync(uploads, { recursive: true });
  const bytes = readFileSync(path.join(repoRoot, "public/fixtures/tone.mp3"));
  const file = path.join(uploads, `${id}.mp3`);
  writeFileSync(file, bytes);
  await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)");
  await db().execute({
    sql: "INSERT OR IGNORE INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?,?)",
    args: [id, "Long.mp3", "audio/mpeg", "mp3", bytes.length, "x", `/api/uploads/${id}`, "audio", seconds, Date.now()],
  });
  return { id, cleanup: () => rmSync(file, { force: true }) };
}
const repoRoot = path.resolve(__dirname, "../..");

test("dubbing, run for real: an hour of source (about $30) is refused for a member and a machine before any take or job row is written, at the quote and at the press; an admin's tap clears it", async () => {
  const { executeDubbingAdmission } = await import("../../lib/dubbing");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  const ws = workspace(`dub_${run}`);
  await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_dub_${run}`, ws.id, 100_000, "Test", Date.now()] });
  for (const [who, role] of [["u_member", "member"], ["u_admin", "admin"], ["agent:run_dub", "admin"]] as const)
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, who, role] });
  const rows = async (table: string) => Number((await db().execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  const noop = { defer: async () => {} };
  const member = { user: person("u_member", "member") };
  const admin = { user: person("u_admin", "admin") };
  const agent = { user: person("agent:run_dub", "admin") };
  const token = { user: person("u_admin", "admin"), token: { id: "tok_dub", name: "agent", scope: "render" as const, capUsd: null } };
  let cleanup = () => {};
  let id = "";
  /* The admission asserts the actor is the signed-in tenant, so each actor runs in its own scope. */
  await runInTenant(ws, async () => { await ready(); const seeded = await seedLongSource(3600); id = seeded.id; cleanup = seeded.cleanup; }, member);
  /* Atomik's id is a real run with a person behind it (owner-approved fixture, 19 Oct): an agent id with no run is refused before any quote (lib/mediaSource.server.ts). */
  await runInTenant(ws, async () => {
    const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
    await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_dub", "prod_dub", "draft_dub", "u_admin", `req_dub_${run}`, "goal", "auto", "running"] });
  }, member);
  const body = () => ({ sourceUploadId: id, sourceLang: "en", targetLang: "es", mode: "v1", projectId: "project" });
  try {
    for (const [who, words] of [[member, /An admin has to start it\./], [agent, /never start it\./], [token, /never start it\./]] as const) {
      await runInTenant(ws, async () => {
        await ready();
        /* At the quote, then at the press (a generous approval, so only this guardrail can stop it). */
        for (const quoteOnly of [true, false]) {
          const reply = await executeDubbingAdmission({ ...body(), quoteOnly, maxCredits: 5000 }, who, noop);
          expect(reply.status, `${who.user.id} quoteOnly ${quoteOnly}`).toBe(403);
          expect(reply.body, `${who.user.id} quoteOnly ${quoteOnly}`).toMatchObject({ needsAdmin: true });
          expect(String(reply.body.error)).toMatch(words);
        }
        expect(await rows("generations")).toBe(0);
        expect(await rows("dubbing_jobs")).toBe(0);
      }, who);
    }
    /* An admin's own tap is not stopped by the line: the quote answers. */
    await runInTenant(ws, async () => {
      await ready();
      const quote = await executeDubbingAdmission({ ...body(), quoteOnly: true }, admin, noop);
      expect(quote.status).toBe(200);
      expect(Number(quote.body.estimatedCredits)).toBeGreaterThan(LINE);
    }, admin);
  } finally { cleanup(); }
});

test("audio: the line is judged at the quote, before the claim (tripwire; audio cannot reach 200 cr with real inputs: 5,000 characters of speech price about 14 cr, five minutes of music about 13, a sound effect 1)", async () => {
  const { readFileSync } = await import("node:fs");
  const dub = readFileSync(path.join(repoRoot, "lib/dubbing.ts"), "utf8");
  const dubAt = dub.indexOf("jobLineNow({");
  expect(dubAt, "dubbing judges the line").toBeGreaterThan(0);
  for (const later of ["if (quoteOnly)", "INSERT INTO generations", "claimBinding("]) expect(dubAt, later).toBeLessThan(dub.indexOf(later, dubAt));
  const audio = readFileSync(path.join(repoRoot, "lib/audioAdmission.ts"), "utf8");
  const audioAt = audio.indexOf("jobLineNow({");
  expect(audioAt, "audio judges the line").toBeGreaterThan(0);
  expect(audioAt).toBeLessThan(audio.indexOf("if (quoteOnly)", audioAt));
});
