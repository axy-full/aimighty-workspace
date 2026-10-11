import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { JOB_APPROVAL_LINE_USD, jobApprovalLineCredits, jobLineVerdict } from "../../lib/approvalRule";
import { quoteOf, verdictOf, type Context, type Unit } from "../../lib/quote";

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
    const ws = workspace(`line_${name}`);
    await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_line_${name}`, ws.id, 100_000, "Test", 0] });
    return ws;
  };
  const { over, under } = await costs();
  const reserved = async (id: string) => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=?", args: [id] })).rows[0].n);
  const refusal = async (run: () => Promise<unknown>) => { try { await run(); } catch (e) { return e as InstanceType<typeof SpendReservationError>; } return null; };
  const as = (user: TenantUser | null, extra: { token?: { id: string; name: string; scope: "render" | "prepare"; capUsd: number | null } } = {}) => ({ user, ...extra });

  await runInTenant(await funded("member"), async () => {
    await ready();
    /* A member, whatever the rule (the default is "anyone") and with or without a shot: refused, 403, nothing reserved. */
    const noShot = await refusal(() => reserveGenerationSpend(event("gen_member_a", over)));
    expect(noShot).toBeInstanceOf(SpendReservationError);
    expect(noShot).toMatchObject({ status: 403 });
    expect(noShot!.message).toMatch(/An admin has to start it\./);
    expect(await reserved("gen_member_a")).toBe(0);
  }, as(person("u_member", "member")));
  await runInTenant(await funded("member2"), async () => {
    const withShot = await refusal(() => reserveGenerationSpend(event("gen_member_b", over, { shotId: "shot_x" })));
    expect(withShot).toMatchObject({ status: 403 });
    expect(await reserved("gen_member_b")).toBe(0);
    /* Under the line the same member reserves as ever. */
    await reserveGenerationSpend(event("gen_member_c", under));
    expect(await reserved("gen_member_c")).toBe(1);
  }, as(person("u_member", "member")));
  /* An admin's own tap clears it. */
  await runInTenant(await funded("admin"), async () => {
    await reserveGenerationSpend(event("gen_admin_a", over));
    expect(await reserved("gen_admin_a")).toBe(1);
  }, as(person("u_admin", "admin")));
  /* A token, admin's or not, is refused outright; so is an agent identity acting under an admin's session. */
  await runInTenant(await funded("token"), async () => {
    const t = await refusal(() => reserveGenerationSpend(event("gen_token_a", over), { token: { id: "tok1", capUsd: null, capCredits: null } }));
    expect(t).toMatchObject({ status: 403 });
    expect(t!.message).toMatch(/Atomik, an MCP client and API tokens can prepare it, never start it\./);
    const a = await refusal(() => reserveGenerationSpend(event("gen_agent_a", over, { createdBy: "agent:run_1" })));
    expect(a).toMatchObject({ status: 403 });
    expect(await reserved("gen_token_a") + await reserved("gen_agent_a")).toBe(0);
    /* A machine under the line is not stopped by this guardrail. */
    await reserveGenerationSpend(event("gen_token_b", under), { token: { id: "tok1", capUsd: null, capCredits: null } });
    expect(await reserved("gen_token_b")).toBe(1);
  }, as(person("u_admin", "admin"), { token: { id: "tok1", name: "agent", scope: "render", capUsd: null } }));
  /* A held take's release decides from its author: an admin author's clears it, a member author's does not. */
  await runInTenant(await funded("held"), async () => {
    await reserveGenerationSpend(event("gen_held_admin", over, { createdBy: "u_admin" }), { adminTap: true });
    expect(await reserved("gen_held_admin")).toBe(1);
    const m = await refusal(() => reserveGenerationSpend(event("gen_held_member", over, { createdBy: "u_member" }), { adminTap: false }));
    expect(m?.message).toMatch(/An admin has to start it/);
    expect(m).toMatchObject({ status: 403 });
    expect(await reserved("gen_held_member")).toBe(0);
  }, as(null));
});

test("before a take is parked or sent (admission): the same words, the hold counts, and a member's over-line take is told at the press, never parked", async () => {
  const { jobLineGate } = await import("../../lib/shotCap");
  const { runInTenant } = await import("../../lib/tenant");
  const { over, under } = await costs();
  await runInTenant(workspace("gate"), async () => {
    const member = { isAdmin: false, machine: false, modelId: "mock" };
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
