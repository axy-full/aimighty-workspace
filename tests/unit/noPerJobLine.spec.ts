import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { ruleLine, shotCapVerdict } from "../../lib/approvalRule";
import { quoteOf, verdictOf, type Context, type Unit } from "../../lib/quote";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { keepingHouseJobsClean } from "../helpers/houseJobs";

/**
 * No per-job line (owner, 20 October 2026, verbatim): "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the
 * product. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused."
 *
 * This file pinned guardrail 4 (SOW §7A: a single job above US$20, 200 cr at a credit's US$0.10, needed an admin's own tap; a token, an MCP
 * client or Atomik was refused outright). It now pins its retirement: no job is refused, parked or sent to an admin for its size alone, at
 * the quote, the press, the reservation, a held take's release, or the audio, dubbing and text quotes. What still stops a job is pinned
 * here as unchanged: the balance, the workspace's monthly cap, the house's cap, the workspace's OWN per-shot rule, a token's own ceiling
 * and a run's approved limit; and approving stays a person's (an agent, an MCP client or a token can prepare, never approve).
 * Mocked providers only: no engine is called, no credit is spent; real temporary databases for the reservation.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-no-per-job-line-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const workspace = (name: string, extra: Partial<TenantWorkspace> = {}): TenantWorkspace => ({ id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null,
  flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null, ...extra });
/* A token's monthly ceiling far above every job here (synthetic): since #854 a token with none only prepares and prices (lib/tokenSpend.ts) and is
   refused at the reservation for that, so the token cases carry one to test what this file pins. */
const ROOMY = { capUsd: 1_000_000, capCredits: 1_000_000 };
const person = (id: string, role: "admin" | "member"): TenantUser => ({ id, email: `${id}@example.test`, name: id, role, owner: role === "admin", disabled: false, lastSeen: null, createdAt: 0 });
const houseOf = (name: string): TenantWorkspace => ({ ...workspace(name), id: "ws_legacy", slug: "house", name: "House", legacy: true, usesPlatformKeys: false, concurrency: 1000, rendersPerHour: 100_000 });
/* Ids and workspace names are this run's own: another spec in the same worker may share the databases, and a job id belongs to one workspace. */
test.beforeAll(async () => { await alignLedgerUnit(); });
const run = Math.random().toString(36).slice(2, 8);
const repoRoot = path.resolve(__dirname, "../..");

/** Every TypeScript source under a folder of the product. */
function sources(folder: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.tsx?$/.test(name)) out.push(file);
    }
  };
  walk(path.join(repoRoot, folder));
  return out;
}

test("the code carries no per-job line and no Auto ceiling: no constant, verdict or gate of either is exported or used anywhere in the product, and the old Auto setting is not read; the workspace's own rule is what remains", async () => {
  const rule = await import("../../lib/approvalRule") as Record<string, unknown>;
  for (const gone of ["JOB_APPROVAL_LINE_USD", "jobApprovalLineCredits", "jobLineVerdict", "JOB_LINE_STATUS"]) expect(rule[gone], gone).toBeUndefined();
  const shotCap = await import("../../lib/shotCap") as Record<string, unknown>;
  for (const gone of ["jobLineGate", "jobLineGateAt", "jobLineNow"]) expect(shotCap[gone], gone).toBeUndefined();
  /* One press counted as one job was the line's alone; it is gone with it. */
  expect(existsSync(path.join(repoRoot, "lib/batchLine.ts"))).toBe(false);
  /* Tripwire: nothing in the product names the line again. */
  const named = /\b(JOB_APPROVAL_LINE_USD|jobApprovalLineCredits|jobLineVerdict|JOB_LINE_STATUS|jobLineGate|jobLineGateAt|jobLineNow)\b|lib\/batchLine|"\.\/batchLine"/;
  const product = ["lib", "app", "components"].flatMap(sources).map((file) => ({ file: path.relative(repoRoot, file), text: readFileSync(file, "utf8") }));
  expect(product.filter((f) => named.test(f.text)).map((f) => f.file)).toEqual([]);
  /* Nor Auto's no-tap ceiling (owner, 20 Oct 2026: "Auto goes"): none of its names is used anywhere in the product. */
  const auto = /\b(AUTO_NO_TAP_CEILING_USD|autoNoTapCeilingCredits|RIG_AGENT_JOB_CEILING_CREDITS|rigJobCeiling|effectiveJobCeiling|autoLineCredits|spendsWithoutAsking)\b/;
  expect(product.filter((f) => auto.test(f.text)).map((f) => f.file)).toEqual([]);
  /* And the old Auto setting is neither read nor written: its key appears nowhere in the product, in any form (string, property, destructured or bare). */
  const setting = /\bspendWithoutAsking\b/;
  expect(product.filter((f) => setting.test(f.text)).map((f) => f.file)).toEqual([]);
  /* What stays: the workspace's own rule. With "cap per shot", a member's take that carries a shot past the cap needs an admin; an admin's goes. */
  const cr = (n: number) => `${n} cr`;
  expect(shotCapVerdict({ rule: "cap", isAdmin: false, cap: 50, shotCredits: 40, takeCredits: 20, code: "SH010" }, cr))
    .toEqual({ blocked: true, line: "SH010 is at 40 cr; this take makes it 60 cr, over the 50 cr a shot may take. An admin has to press this one." });
  expect(shotCapVerdict({ rule: "cap", isAdmin: true, cap: 50, shotCredits: 40, takeCredits: 20, code: "SH010" }, cr).blocked).toBe(false);
  /* The rule decides alone: "anyone" and "producer" stop no one, at any size. */
  for (const r of ["anyone", "producer"] as const) expect(shotCapVerdict({ rule: r, isAdmin: false, cap: 50, shotCredits: 0, takeCredits: 5000, code: "SH010" }, cr).blocked, r).toBe(false);
  expect(ruleLine("cap", 50, cr)).toBe("Over 50 cr on a shot needs an admin.");
  expect(ruleLine("anyone", 50, cr)).toBe("");
});

const base: Context = { balance: 10_000, allowance: null, caps: {}, warnPct: 80, rule: "anyone", shotCap: 50, isAdmin: false };
const unit = (usd: number, key = "s1"): Unit => ({ key, usd, engine: "dreamina-seedance-2-5-260628", spent: 0, code: "SH010", projectId: null, platformPays: true });

/** The dollars of an engine cost that price at about `credits` (the quote's own pricing, margin and rounding included). */
function usdFor(credits: number): number {
  let usd = credits * 0.1;
  for (let i = 0; i < 12; i++) usd *= credits / quoteOf([unit(usd)]).totalCredits;
  return usd;
}

test("the quote: a job far over 200 cr is allowed for a member under any rule that allows it; the workspace's own per-shot cap still stops a member and not an admin; takes multiplied are one line, still allowed", () => {
  const big = quoteOf([unit(usdFor(250))]);
  expect(big.totalCredits).toBeGreaterThan(200);
  /* No rule, a producer's sign-off, or a cap the job fits under: the member is allowed, whatever the job's size. */
  for (const c of [{ ...base, rule: "anyone" }, { ...base, rule: "producer" }, { ...base, rule: "cap", shotCap: 1000 }] as const)
    expect(verdictOf(big, c), c.rule).toMatchObject({ allow: true });
  /* The workspace's own per-shot cap, unchanged: a member past it is stopped with its own words, an admin is not. */
  const capped = verdictOf(big, { ...base, rule: "cap", shotCap: 50 });
  expect(capped).toMatchObject({ allow: false, gate: "approval" });
  expect(capped.line).toMatch(/over the 50 cr a shot may take\. An admin has to press this one\./);
  expect(verdictOf(big, { ...base, rule: "cap", shotCap: 50, isAdmin: true }).allow).toBe(true);
  /* Four takes of ~70 cr (~280 cr as one line): allowed. */
  const batch = quoteOf([{ ...unit(usdFor(70)), count: 4 }]);
  expect(batch.lines[0].count).toBe(4);
  expect(batch.totalCredits).toBeGreaterThan(200);
  expect(verdictOf(batch, base).allow).toBe(true);
  /* Work the platform does not pay for, and the house at cost ($25, once 250 cr at cost and over the line): allowed. */
  expect(verdictOf(quoteOf([{ ...unit(usdFor(300)), platformPays: false }]), base).allow).toBe(true);
  expect(verdictOf(quoteOf([{ ...unit(25), platformPays: false }]), { ...base, balance: null, houseCap: null }).allow).toBe(true);
});

test("the quote's context carries no line: a token's, an agent's and a person's contexts give the same verdict on a job over 200 cr", async () => {
  const { contextFor } = await import("../../lib/impact");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const big = quoteOf([unit(usdFor(250))]);
  const ws = workspace(`ctx_${run}`);
  const verdicts: unknown[] = [];
  for (const who of [
    { user: person("u_admin", "admin") },
    { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render" as const, capUsd: null } },
    { user: person("agent:run_2", "member") },
    { user: person("u_member", "member") },
  ]) {
    await runInTenant(ws, async () => {
      await ready();
      const ctx = await contextFor([], { isAdmin: who.user.role === "admin" });
      expect(ctx).not.toHaveProperty("jobLine");
      verdicts.push(verdictOf(big, ctx));
    }, who);
  }
  for (const v of verdicts) expect(v).toMatchObject({ allow: true });
});

/** A paid job whose bill is well over, or well under, the old line. */
async function costs() {
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const per = creditsAtTerms(1, currentBillingTerms("video", "mock"));
  return { over: 250 / per, under: 120 / per, per };
}
const event = (id: string, engineCostUsd: number, extra: Record<string, unknown> = {}) => ({ id, kind: "video" as const, engine: "byteplus", model: "mock", status: "running" as const, engineCostUsd, ...extra });
async function reservation() {
  const { reserveGenerationSpend, SpendReservationError, RUN_LIMIT_REACHED } = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { ready } = await import("../../lib/db");
  await platformReady();
  const funded = async (name: string, extra: Partial<TenantWorkspace> = {}, credits = 100_000) => {
    const ws = workspace(`${name}_${run}`, extra);
    if (credits > 0) await platformDb().execute({ sql: `INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)`, args: [`grant_${name}_${run}`, ws.id, credits, "Test", 0] });
    return ws;
  };
  const reserved = async (id: string) => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=?", args: [id] })).rows[0].n);
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); } catch (e) { return e as InstanceType<typeof SpendReservationError>; } return null; };
  return { reserveGenerationSpend, SpendReservationError, RUN_LIMIT_REACHED, runInTenant, ready, funded, reserved, refusal };
}

test("the reservation: a job far over 200 cr is reserved for a member, an admin, a token, an agent identity and a reservation with nobody behind it, with no admin rule firing when the workspace's own rule allows it", async () => {
  const { reserveGenerationSpend, runInTenant, ready, funded, reserved } = await reservation();
  const { over, under } = await costs();
  const cases: [string, Parameters<typeof runInTenant>[2], Record<string, unknown>, Record<string, unknown>][] = [
    ["member", { user: person("u_member", "member") }, {}, {}],
    ["member_shot", { user: person("u_member", "member") }, { shotId: "shot_x" }, {}],
    ["admin", { user: person("u_admin", "admin") }, {}, {}],
    ["token", { user: person("u_admin", "admin"), token: { id: "tok1", name: "agent", scope: "render", ...ROOMY } }, {}, { token: { id: "tok1", ...ROOMY } }],
    ["agent", { user: person("u_admin", "admin") }, { createdBy: "agent:run_1" }, {}],
    ["nobody", { user: null }, {}, {}],
    ["author", { user: null }, { createdBy: "u_someone" }, {}],
  ];
  for (const [name, who, extra, options] of cases) {
    await runInTenant(await funded(`res_${name}`), async () => {
      await ready();
      await reserveGenerationSpend(event(`gen_res_${name}_${run}`, over, extra), options);
      expect(await reserved(`gen_res_${name}_${run}`), name).toBe(1);
      await reserveGenerationSpend(event(`gen_res_${name}_u_${run}`, under, extra), options);
      expect(await reserved(`gen_res_${name}_u_${run}`), `${name} under`).toBe(1);
    }, who);
  }
});

test("the reservation either side of the old line: 200 cr and 201 cr are both reserved for a member; the house at cost too ($25 and $15 alike, for a member, a token and an agent)", async () => {
  const { reserveGenerationSpend, runInTenant, ready, funded, reserved } = await reservation();
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const terms = currentBillingTerms("video", "mock");
  const per = creditsAtTerms(1000, terms) / 1000;
  const costFor = (credits: number) => { let usd = (credits - 0.5) / per; for (let i = 0; i < 20 && creditsAtTerms(usd, terms) !== credits; i++) usd *= credits / creditsAtTerms(usd, terms); return usd; };
  for (const credits of [200, 201]) {
    const usd = costFor(credits);
    expect(creditsAtTerms(usd, terms)).toBe(credits);
    await runInTenant(await funded(`edge${credits}`), async () => {
      await ready();
      await reserveGenerationSpend(event(`gen_edge${credits}_${run}`, usd));
      expect(await reserved(`gen_edge${credits}_${run}`)).toBe(1);
    }, { user: person("u_member", "member") });
  }
  await keepingHouseJobsClean(async () => {
    await runInTenant(houseOf(`house_${run}`), async () => {
      await ready();
      await reserveGenerationSpend(event(`gen_house_m25_${run}`, 25));
      await reserveGenerationSpend(event(`gen_house_m15_${run}`, 15));
      await reserveGenerationSpend(event(`gen_house_t_${run}`, 25), { token: { id: "tok_h", ...ROOMY } });
      await reserveGenerationSpend(event(`gen_house_a_${run}`, 25, { createdBy: "agent:run_9" }));
      for (const id of ["m25", "m15", "t", "a"]) expect(await reserved(`gen_house_${id}_${run}`), id).toBe(1);
    }, { user: person("u_member", "member") });
  });
});

test("what still stops a job over 200 cr, exactly as before: the balance, the workspace's monthly cap, the house's cap, the workspace's own per-shot cap, a token's own ceiling and a run's approved limit", async () => {
  const { reserveGenerationSpend, SpendReservationError, RUN_LIMIT_REACHED, runInTenant, ready, funded, reserved, refusal } = await reservation();
  const { HOUSE_CAP_REACHED, HOUSE_CAP_DEFAULT_USD } = await import("../../lib/houseCap");
  const { setSetting } = await import("../../lib/settings");
  const { over } = await costs();
  /* The balance: short of the job's bill, nothing is reserved (402). */
  await runInTenant(await funded("short", {}, 0), async () => {
    await ready();
    const e = await refusal(() => reserveGenerationSpend(event(`gen_short_${run}`, over)));
    expect(e).toBeInstanceOf(SpendReservationError);
    expect(e).toMatchObject({ status: 402 });
    expect(await reserved(`gen_short_${run}`)).toBe(0);
  }, { user: person("u_admin", "admin") });
  /* The workspace's monthly cap on the platform's engines (its allowance): 429 with its own words, an admin's job too. */
  await runInTenant(await funded("monthly", { allowanceUsd: over / 2 }), async () => {
    await ready();
    const e = await refusal(() => reserveGenerationSpend(event(`gen_monthly_${run}`, over)));
    expect(e).toMatchObject({ status: 429, message: "This job and the reserved jobs would exceed the workspace's monthly spending cap." });
    expect(await reserved(`gen_monthly_${run}`)).toBe(0);
  }, { user: person("u_admin", "admin") });
  /* The house's own monthly cap (lib/houseCap.ts): a job past it is refused with its words, an admin's too. */
  await keepingHouseJobsClean(async () => {
    await runInTenant(houseOf(`house_cap_${run}`), async () => {
      await ready();
      const e = await refusal(() => reserveGenerationSpend(event(`gen_housecap_${run}`, HOUSE_CAP_DEFAULT_USD + 100)));
      expect(e).toMatchObject({ status: 429, message: HOUSE_CAP_REACHED });
      expect(await reserved(`gen_housecap_${run}`)).toBe(0);
    }, { user: person("u_admin", "admin") });
  });
  /* The workspace's own per-shot cap ("cap per shot", 50 cr): a member's take past it needs an admin; an admin's goes; with no rule the member's goes. */
  const capped = await funded("shotcap");
  await runInTenant(capped, async () => {
    await ready();
    await setSetting("approvalRule", "cap", "u_admin");
    await setSetting("shotCapCredits", "50", "u_admin");
    const e = await refusal(() => reserveGenerationSpend(event(`gen_shotcap_m_${run}`, over, { shotId: "shot_c" })));
    expect(e).toMatchObject({ status: 403, message: "This take and reserved takes exceed the shot's credit cap. An admin must start it." });
    expect(await reserved(`gen_shotcap_m_${run}`)).toBe(0);
  }, { user: person("u_member", "member") });
  await runInTenant(capped, async () => {
    await reserveGenerationSpend(event(`gen_shotcap_a_${run}`, over, { shotId: "shot_c" }));
    expect(await reserved(`gen_shotcap_a_${run}`)).toBe(1);
    await setSetting("approvalRule", "anyone", "u_admin");
  }, { user: person("u_admin", "admin") });
  await runInTenant(capped, async () => {
    await reserveGenerationSpend(event(`gen_shotcap_free_${run}`, over, { shotId: "shot_d" }));
    expect(await reserved(`gen_shotcap_free_${run}`)).toBe(1);
  }, { user: person("u_member", "member") });
  /* A token's own monthly ceiling in credits. */
  await runInTenant(await funded("tokcap"), async () => {
    await ready();
    const e = await refusal(() => reserveGenerationSpend(event(`gen_tokcap_${run}`, over), { token: { id: "tok_cap", capUsd: null, capCredits: 100 } }));
    expect(e).toMatchObject({ status: 429, message: "This job and the reserved jobs would pass this token's 100 cr monthly ceiling." });
    expect(await reserved(`gen_tokcap_${run}`)).toBe(0);
  }, { user: person("u_admin", "admin"), token: { id: "tok_cap", name: "agent", scope: "render", capUsd: null } });
  /* A run's approved limit (an Atomik run): past it, nothing is reserved. */
  await runInTenant(await funded("runcap"), async () => {
    await ready();
    const e = await refusal(() => reserveGenerationSpend(event(`gen_runcap_${run}`, over), { run: { id: `run_cap_${run}`, limitCredits: 100, band: 1 } }));
    expect(e).toMatchObject({ status: 409, message: RUN_LIMIT_REACHED });
    expect(await reserved(`gen_runcap_${run}`)).toBe(0);
  }, { user: person("u_member", "member") });
});

test("Atomik: a person-tapped run step over 200 cr is reserved inside the run's approved limit, for a member too; there is no Auto (owner, 20 Oct 2026): no no-tap ceiling exists and a run spend carries no Auto mark", async () => {
  const { reserveGenerationSpend, runInTenant, ready, funded, reserved } = await reservation();
  const limits = await import("../../lib/workbench/rig-agent-limits") as Record<string, unknown>;
  for (const gone of ["AUTO_NO_TAP_CEILING_USD", "autoNoTapCeilingCredits", "RIG_AGENT_JOB_CEILING_CREDITS", "rigJobCeiling", "effectiveJobCeiling"]) expect(limits[gone], gone).toBeUndefined();
  const { over } = await costs();
  await runInTenant(await funded("atomik"), async () => {
    await ready();
    const spend = { id: `run_tap_${run}`, limitCredits: 1_000_000, band: 1 };
    await reserveGenerationSpend(event(`gen_tap_${run}`, over, { createdBy: "agent:run_tap" }), { run: spend });
    expect(await reserved(`gen_tap_${run}`)).toBe(1);
  }, { user: person("u_member", "member") });
  /* Nothing marks a run's job as approved by Auto: the run's spend never sets `auto` (lib/workbench/rig-agent-runs.ts runSpend), and no step is approved by "auto". */
  const runs = readFileSync(path.join(repoRoot, "lib/workbench/rig-agent-runs.ts"), "utf8");
  expect(runs).not.toMatch(/auto: true|approved_by: "auto"/);
});

test("held takes released through releaseHeldJobs: a member's held take over the old line is released by a poll, like an admin's; nothing asks for an admin's standing", async () => {
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
  /* The held take is far over 200 cr: its `needs` is its bill at its hold. */
  expect(heldInfo(60, "video", "dreamina-seedance-2-0-260128", "slots").needs).toBeGreaterThan(200);
  const defer = (work: () => unknown) => { void work; };
  await runInTenant(ws, async () => {
    await ready();
    await heldRow(`gen_held_a_${run}`, `u_held_admin_${run}`);
    const first = await releaseHeldJobs({ defer });
    expect(await state(`gen_held_a_${run}`), JSON.stringify(first)).not.toBe("held");
    await heldRow(`gen_held_m_${run}`, `u_held_member_${run}`);
    const polled = await releaseHeldJobs({ defer });
    expect(polled.released, JSON.stringify(polled)).toContain(`gen_held_m_${run}`);
    expect(await state(`gen_held_m_${run}`)).not.toBe("held");
  }, { user: null });
});

test("audio, dubbing and text quotes: a job over 200 cr is quoted for a member, an admin, a token and an agent alike; the press still carries its approval of the quote", async () => {
  const { paidTextQuoteResponse } = await import("../../lib/paidText");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace(`quotes_${run}`);
  const quote = (credits: number) => ({ model: "m", effort: "auto", estimateCredits: credits, estimateUsd: credits / 10 });
  for (const who of [{ user: person("u_member", "member") }, { user: person("u_admin", "admin") },
    { user: person("u_admin", "admin"), token: { id: "tok", name: "agent", scope: "render" as const, capUsd: null } }, { user: person("agent:run_1", "admin") }]) {
    await runInTenant(ws, async () => {
      const answer = paidTextQuoteResponse(quote(300));
      expect(answer.status, who.user.id).toBe(200);
      expect(await answer.json(), who.user.id).not.toHaveProperty("needsAdmin");
    }, who);
  }
  const house = houseOf(`quotes_house_${run}`);
  await runInTenant(house, async () => { expect(paidTextQuoteResponse(quote(300)).status).toBe(200); }, { user: person("u_member", "member") });
});

/** A stored audio original with a recorded length, as the dubbing spec seeds one (its bytes on disk are the fixture tone). */
async function seedLongSource(seconds: number) {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { db } = await import("../../lib/db");
  const id = `npldub${run}`;
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

test("dubbing, run for real: an hour of source (about $30, far over 200 cr) is quoted for a member, an admin, an agent and a token; a press whose approval is under the quote is refused before any take or job row is written", async () => {
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
    let quoted = 0;
    for (const who of [member, admin, agent, token]) {
      await runInTenant(ws, async () => {
        await ready();
        const reply = await executeDubbingAdmission({ ...body(), quoteOnly: true }, who, noop);
        expect(reply.status, `${who.user.id}: ${JSON.stringify(reply.body)}`).toBe(200);
        expect(reply.body, who.user.id).not.toHaveProperty("needsAdmin");
        quoted = Number(reply.body.estimatedCredits);
        expect(quoted, who.user.id).toBeGreaterThan(200);
      }, who);
    }
    /* Approved on its quote: a press carrying an approval under the quote is refused, and nothing is written. */
    await runInTenant(ws, async () => {
      await ready();
      const reply = await executeDubbingAdmission({ ...body(), maxCredits: Math.floor(quoted) - 50 }, member, noop);
      expect(reply.status, JSON.stringify(reply.body)).toBe(409);
      expect(String(reply.body.error)).toMatch(/exceeds the approved credit amount/);
      expect(await rows("generations")).toBe(0);
      expect(await rows("dubbing_jobs")).toBe(0);
    }, member);
  } finally { cleanup(); }
});

test("approving stays a person's: an agent, an MCP client, a token, a plan or Auto is never an approver; a signed-in person is", async () => {
  const { isPersonApprover } = await import("../../lib/workbench/plan-approval");
  for (const machine of ["agent:run_1", "mcp:client", "token:tok1", "auto", "plan:p1", "system:x"]) expect(isPersonApprover(machine), machine).toBe(false);
  expect(isPersonApprover("u_member")).toBe(true);
});
