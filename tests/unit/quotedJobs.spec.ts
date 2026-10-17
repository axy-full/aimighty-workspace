import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProviderOutcome } from "../../lib/providerOutcome";

/*
 * v30 PR A3 (docs/plans/v30-data-model.md § 4.1, 4.2, 4.5, 8): the jobs and Agent commands tables, their one writer,
 * and the refund status. Every quote, receipt and amount below is SYNTHETIC, built in the test: none is a price, a
 * margin or a vendor cost.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-quoted-jobs-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const HOUSE = "ws_legacy";
const fileOf = (name: string) => path.join(dir, name + ".db");
const workspace = (id: string, file = id) =>
  ({ id, name: id, slug: id, dbUrl: `file:${fileOf(file)}`, legacy: false, dbToken: null, keys: {}, usesPlatformKeys: true }) as unknown as TenantWorkspace;

/* Synthetic figures, named as such. Not prices. */
const SYNTHETIC_CREDITS = 4.5;
const SYNTHETIC_CREDITS_B = 2;
/* A dollar figure, only to prove it is refused: every quote is in credits, the house's too. */
const SYNTHETIC_USD = 0.25;
const SYNTHETIC_RECEIPT = 3;
const SYNTHETIC_RECEIPT_B = 1.5;
const SYNTHETIC_ENGINE = "synthetic-engine-a3";

const PERSON = { user: { id: "usr_person" } };

const mods = async () => ({
  ...(await import("../../lib/db")),
  ...(await import("../../lib/tenant")),
  ...(await import("../../lib/quotedJobs/store")),
  ...(await import("../../lib/quotedJobs/flag")),
  ...(await import("../../lib/quotedJobs/vocabulary")),
  ...(await import("../../lib/providerOutcome")),
  ...(await import("../../lib/localDatabaseClient")),
  ...(await import("../../lib/security/people-only")),
});

/** A bootstrapped workspace database (today's schema) holding productions from before v30. */
async function existingDatabase(ws: TenantWorkspace, ...productionIds: string[]) {
  const { runInTenant, ready, db } = await mods();
  return runInTenant(ws, async () => {
    await ready();
    for (const id of productionIds.length ? productionIds : ["prj_one"])
      await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,?)", args: [id, "Existing", 1] });
    return db();
  });
}

const columns = async (client: Client, table: string) =>
  (await client.execute({ sql: "SELECT name FROM pragma_table_info(?)", args: [table] })).rows.map((r) => String(r.name));
const schemaNames = async (client: Client) =>
  (await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')")).rows.map((r) => String(r.name));
const raw = async (client: Client, jobId: string) => (await client.execute({ sql: "SELECT * FROM quoted_jobs WHERE id=?", args: [jobId] })).rows[0];

/** Every row of every table but the two new ones, as text: what the test compares to prove nothing else was written. */
async function snapshot(client: Client): Promise<string> {
  const names = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows
    .map((r) => String(r.name)).filter((n) => n !== "quoted_jobs" && n !== "agent_commands");
  const out: Record<string, unknown[]> = {};
  for (const name of names) out[name] = (await client.execute(`SELECT * FROM "${name}" ORDER BY rowid`)).rows.map((r) => ({ ...r }));
  return JSON.stringify(out);
}

/** A person's plan approval (synthetic), as lib/workbench/plan-approval.ts stores it, for a command to point at. */
async function approval(client: Client, id: string, productionId: string, totalTenths: number, opts: { closed?: boolean; expiresAt?: number; approvedBy?: string } = {}) {
  const { PLAN_APPROVAL_SCHEMA, PLAN_APPROVAL_GUARDS } = await import("../../lib/workbench/plan-approval");
  await client.batch([PLAN_APPROVAL_SCHEMA, ...PLAN_APPROVAL_GUARDS], "write");
  const at = Date.now();
  await client.execute({
    sql: `INSERT INTO rig_plan_approvals(id,run_id,production_id,approved_by,approved_at,expires_at,fingerprint,steps,total_tenths,ceiling_tenths,limit_credits,closed_at,closed_reason,created_at)
          VALUES(?,?,?,?,?,?,'synthetic','[]',?,?,?,?,?,?)`,
    args: [id, `run_${id}`, productionId, opts.approvedBy ?? "usr_person", at, opts.expiresAt ?? at + 86_400_000, totalTenths, totalTenths, totalTenths / 10,
      opts.closed ? at : null, opts.closed ? "synthetic" : null, at],
  });
}

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}
const withFlag = <T>(value: string | undefined, fn: () => Promise<T>) => withEnv("V30_JOBS", value, fn);

test("creation is idempotent on an existing database, and the job row holds no charge and no vendor cost", async () => {
  const m = await mods();
  const ws = workspace(HOUSE, "idempotent");
  const client = await existingDatabase(ws);
  await client.execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_old','old-model','old','{}','done',1,1)", args: [] });
  const before = await snapshot(client);
  expect(await schemaNames(client)).not.toContain("quoted_jobs");
  /* A second client object on the same database: the memo is per client object, so through it every statement runs again. */
  const other = m.createPlatformDatabaseClient({ url: ws.dbUrl });
  try {
    await m.runInTenant(ws, async () => {
      const store = m.jobStoreForTests(client, ws.id);
      const again = m.jobStoreForTests(other, ws.id);
      await Promise.all([store.ready(), store.ready(), again.ready()]);
      await again.ready();
      const names = await schemaNames(client);
      for (const name of ["quoted_jobs", "agent_commands", "idx_quoted_jobs_meter", "idx_quoted_jobs_production", "idx_quoted_jobs_command",
        "idx_quoted_jobs_step", "idx_quoted_jobs_take", "idx_quoted_jobs_member", "idx_agent_commands_production", "idx_agent_commands_member",
        "quoted_jobs_fixed", "agent_commands_fixed"])
        expect(names.filter((n) => n === name), name).toHaveLength(1);
      // Nothing that was there changed.
      expect(await snapshot(client)).toBe(before);
      // A job written through one client reads through the other.
      // One unit: the house is quoted in credits too (at cost, as quotedCredits() counts it); a dollar quote is refused.
      await expect(store.createJob({ productionId: "prj_one", decider: "agent", product: "generation", quote: { usd: SYNTHETIC_USD } as never, by: "usr_person" })).rejects.toMatchObject({ status: 400 });
      await expect(store.createCommand({ productionId: "prj_one", instruction: "x", quote: { usd: SYNTHETIC_USD } as never, by: "usr_person" })).rejects.toMatchObject({ status: 400 });
      const job = await store.createJob({ productionId: "prj_one", decider: "agent", product: "generation", quote: { credits: SYNTHETIC_CREDITS }, by: "usr_person" });
      expect((await again.get(job.id))?.id).toBe(job.id);
    });
  } finally {
    /* Closed last: the local client shares one connection per file, so the checks below run first. */
    await checkColumns(client).finally(() => other.close());
  }
});

async function checkColumns(client: Client) {
  // Exactly the plan's columns. No actual, no billed credits, no vendor cost, no margin: the meter stays the money truth.
  expect(await columns(client, "quoted_jobs")).toEqual([
    "workspace_id", "id", "production_id", "step_id", "node_id", "command_id", "decider", "product", "engine", "quote_tenths",
    "quoted_at", "meter_id", "take_id", "source_ref", "status", "refund_status", "error_public", "created_by", "created_at", "started_at",
    "finished_at", "updated_at",
  ]);
  expect(await columns(client, "agent_commands")).toEqual([
    "workspace_id", "id", "production_id", "step_id", "instruction", "quote_tenths", "approval_ref", "run_ref", "state",
    "created_by", "created_at", "updated_at",
  ]);
  for (const table of ["quoted_jobs", "agent_commands"])
    for (const column of await columns(client, table)) expect(column, `${table}.${column}`).not.toMatch(/billed|actual|cost|margin|charge|total|vendor/);
  // The keys lead with workspace_id.
  const pk = (await client.execute("SELECT name FROM pragma_table_info('quoted_jobs') WHERE pk>0 ORDER BY pk")).rows.map((r) => String(r.name));
  expect(pk).toEqual(["workspace_id", "id"]);
}

test("a job is written only with its quote, keeps its quote, decider and engine, and only moves forward", async () => {
  const m = await mods();
  const credit = workspace("ws_credit_rules", "rules");
  const client = await existingDatabase(credit);
  await m.runInTenant(credit, async () => {
    const store = m.jobStoreForTests(client, credit.id);
    const base = { productionId: "prj_one", decider: "director" as const, product: "generation" as const, engine: SYNTHETIC_ENGINE, by: "usr_person" };
    // No quote, two quotes, a negative one, or dollars on a workspace that pays in credits: refused, nothing written.
    for (const quote of [undefined, null, {}, { credits: -1 }, { credits: Number.NaN }, { credits: SYNTHETIC_CREDITS, usd: SYNTHETIC_USD }, { usd: SYNTHETIC_USD }, { credits: "4" }, { credits: 4.55 }, { credits: Number.POSITIVE_INFINITY }, { credits: 1_000_000.1 }, { credits: 1e12 }])
      await expect(store.createJob({ ...base, quote: quote as never })).rejects.toMatchObject({ status: 400 });
    for (const bad of [{ decider: "mode" }, { product: "panel" }, { engine: "has spaces" }, { sourceRef: "no-colon" }, { productionId: "../x" }, { by: "" }])
      await expect(store.createJob({ ...base, quote: { credits: SYNTHETIC_CREDITS }, ...(bad as object) } as never)).rejects.toMatchObject({ status: 400 });
    await expect(store.createJob({ ...base, productionId: "prj_missing", quote: { credits: SYNTHETIC_CREDITS } })).rejects.toMatchObject({ status: 404 });
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM quoted_jobs")).rows[0].n)).toBe(0);
    // Free is a quote; so is the bound itself (the same bound as an Atomik run's limit), in whole tenths.
    expect((await store.createJob({ ...base, quote: { credits: 0 } })).quote).toEqual({ credits: 0 });
    expect((await store.createJob({ ...base, quote: { credits: m.MAX_QUOTE_CREDITS } })).quote).toEqual({ credits: m.MAX_QUOTE_CREDITS });

    const job = await store.createJob({ ...base, quote: { credits: SYNTHETIC_CREDITS }, sourceRef: "paid_text_jobs:ptj_1" });
    expect(job).toMatchObject({ status: "queued", quote: { credits: SYNTHETIC_CREDITS }, actual: null, refundStatus: null, error: null, startedAt: null, finishedAt: null });
    expect(job.quotedAt).toBeGreaterThan(0);
    expect(await raw(client, job.id)).toMatchObject({ quote_tenths: SYNTHETIC_CREDITS * 10, workspace_id: credit.id });

    // Forward only.
    await expect(store.finish(job.id, "done")).rejects.toMatchObject({ status: 409 });
    const running = await store.start(job.id);
    expect(running.status).toBe("running");
    expect(running.startedAt).not.toBeNull();
    await expect(store.start(job.id)).rejects.toMatchObject({ status: 409 });
    const done = await store.finish(job.id, "done");
    expect(done).toMatchObject({ status: "done", refundStatus: null, error: null });
    expect((await raw(client, job.id)).refund_status).toBeNull();
    for (const next of ["failed", "cancelled", "done"] as const) await expect(store.finish(job.id, next)).rejects.toMatchObject({ status: 409 });
    await expect(store.finish(job.id, "running" as never)).rejects.toMatchObject({ status: 400 });

    // The meter and take pointers are set once; a meter record belongs to one job.
    await store.attach(job.id, { meterId: "gen_meter_1", takeId: "gen_meter_1" });
    await store.attach(job.id, { meterId: "gen_meter_1" });
    await expect(store.attach(job.id, { meterId: "gen_meter_2" })).rejects.toMatchObject({ status: 409 });
    await expect(store.attach(job.id, { takeId: "gen_other" })).rejects.toMatchObject({ status: 409 });
    const second = await store.createJob({ ...base, quote: { credits: SYNTHETIC_CREDITS_B } });
    await expect(store.attach(second.id, { meterId: "gen_meter_1" })).rejects.toMatchObject({ status: 409 });
    await expect(store.createJob({ ...base, quote: { credits: SYNTHETIC_CREDITS_B }, meterId: "gen_meter_1" })).rejects.toMatchObject({ status: 409 });

    // The database holds the same rules for any writer that is not this store.
    for (const set of ["engine='other'", "decider='agent'", "quote_tenths=1", "product='reading'", "meter_id='gen_x'", "status='failed', refund_status='refunded'", "workspace_id='ws_other'"])
      await expect(client.execute({ sql: `UPDATE quoted_jobs SET ${set} WHERE id=?`, args: [job.id] }), set).rejects.toThrow(/keeps its quote|CHECK|UNIQUE/i);
    const insert = (over: Record<string, unknown>) => {
      const row: Record<string, unknown> = { workspace_id: credit.id, id: `qjob_raw_${Math.random().toString(36).slice(2)}`, decider: "agent", product: "generation", quoted_at: 1, status: "queued", created_by: "x", created_at: 1, updated_at: 1, ...over };
      const keys = Object.keys(row);
      return client.execute({ sql: `INSERT INTO quoted_jobs(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, args: keys.map((k) => row[k]) as never });
    };
    await expect(insert({})).rejects.toThrow(/NOT NULL/i); // no quote
    await expect(insert({ quote_tenths: 1, refund_status: "refunded" })).rejects.toThrow(/CHECK/i); // a refund status on a queued job
    await expect(insert({ quote_tenths: 1, status: "failed" })).rejects.toThrow(/CHECK/i); // a failed job without one
    await expect(insert({ quote_tenths: 1, decider: "mode" })).rejects.toThrow(/CHECK/i);
    await expect(insert({ quote_tenths: 1, status: "failed", refund_status: "partly" })).rejects.toThrow(/CHECK/i);
    await expect(insert({ quote_tenths: 1, command_id: "acmd_x", decider: "director" })).rejects.toThrow(/CHECK/i); // commands are Agent mode
    await expect(insert({ quote_tenths: -1 })).rejects.toThrow(/CHECK/i);
    await insert({ quote_tenths: 1 }); // the shape itself is fine
  });
});

/** Settled failures as each provider's own parser reads them, plus synthetic outcomes built here for the states no parser in a fixture reaches. */
async function outcomeFixtures(): Promise<{ name: string; outcome: ProviderOutcome; expected: string }[]> {
  const o = await import("../../lib/providerOutcome");
  const synthetic = (state: "billed" | "refunded" | "not_charged" | "unknown", funding?: "platform" | "own"): ProviderOutcome => ({
    v: 1, provider: "fal", stage: "run", code: "synthetic_code", kind: "provider_error", message: "Synthetic vendor words: model synthetic-engine-a3 failed.",
    billing: { state, basis: "silent" }, ...(funding ? { funding } : {}), at: 1,
  });
  return [
    { name: "engine api nsfw", outcome: o.higgsfieldRequestOutcome({ request_id: "req_1", status: "nsfw" })!, expected: "refunded" },
    { name: "engine api failed", outcome: o.higgsfieldRequestOutcome({ request_id: "req_2", status: "failed", error: "Synthetic: out of memory." })!, expected: "refunded" },
    { name: "engine api canceled", outcome: o.higgsfieldRequestOutcome({ request_id: "req_3", status: "canceled" })!, expected: "not_charged" },
    { name: "engine refusal 503", outcome: o.higgsfieldRefusalOutcome(503, null), expected: "unknown" },
    { name: "account refunded (synthetic ledger)", outcome: o.higgsfieldAccountOutcome("nsfw", { ledger: { refund: true, spend: true, refunded: SYNTHETIC_CREDITS, spent: SYNTHETIC_CREDITS } }), expected: "refunded" },
    { name: "account silent", outcome: o.higgsfieldAccountOutcome("nsfw"), expected: "unknown" },
    { name: "ark cancelled", outcome: o.arkTaskOutcome({ status: "cancelled" })!, expected: "not_charged" },
    { name: "ark refusal 400", outcome: o.arkRefusalOutcome(400, JSON.stringify({ error: { code: "InputTextSensitiveContentDetected", message: "Synthetic." } })), expected: "not_charged" },
    { name: "google 503", outcome: o.googleErrorOutcome(503, { error: { code: 503, message: "Synthetic overload.", status: "UNAVAILABLE" } }), expected: "unknown" },
    { name: "gateway zero", outcome: o.gatewayRefusalOutcome(0, null), expected: "not_charged" },
    { name: "fal 500", outcome: o.falErrorOutcome(500, { detail: "Synthetic." }, "run"), expected: "not_charged" },
    { name: "no answer", outcome: o.noAnswerOutcome("byteplus", "run"), expected: "unknown" },
    { name: "safety block", outcome: o.safetyBlockOutcome("google", "SAFETY"), expected: "not_charged" },
    { name: "synthetic billed, platform", outcome: synthetic("billed", "platform"), expected: "billed" },
    { name: "synthetic refunded, own", outcome: synthetic("refunded", "own"), expected: "refunded" },
    { name: "synthetic not charged", outcome: synthetic("not_charged"), expected: "not_charged" },
    { name: "synthetic unknown", outcome: synthetic("unknown"), expected: "unknown" },
  ];
}

test("refund status: one mapping from the provider's outcome, the same as the stored outcome's billing state for every settled fixture", async () => {
  const m = await mods();
  const fixtures = await outcomeFixtures();
  // Every one of the four states is exercised.
  expect(new Set(fixtures.map((f) => f.outcome.billing.state))).toEqual(new Set(m.BILLING_STATES));
  expect([...m.REFUND_STATUSES]).toEqual([...m.BILLING_STATES]);

  const house = workspace(HOUSE, "refund-house");
  const credit = workspace("ws_credit_refund", "refund-credit");
  for (const ws of [house, credit]) {
    const client = await existingDatabase(ws);
    await m.runInTenant(ws, async () => {
      const store = m.jobStoreForTests(client, ws.id);
      const quote = { credits: SYNTHETIC_CREDITS };
      for (const [i, { name, outcome, expected: literal }] of fixtures.entries()) {
        const job = await store.createJob({ productionId: "prj_one", decider: i % 2 ? "agent" : "director", product: "generation", engine: SYNTHETIC_ENGINE, quote, by: "usr_person" });
        if (i % 3) await store.start(job.id);
        const status = i % 4 === 0 ? "cancelled" : "failed";
        // Half as the object meter() receives, half as the JSON generations.provider_outcome stores.
        const stored = m.serializeOutcome(outcome);
        const finished = await store.finish(job.id, status, i % 2 ? outcome : stored);
        const expected = m.parseOutcome(stored)!.billing.state;
        // The literal answer for each fixture (engine nsfw → refunded, engine canceled → not_charged, no answer → unknown …),
        // alongside the comparison with the stored outcome.
        expect(expected, name).toBe(literal);
        expect(m.refundStatusOf(outcome), name).toBe(expected);
        expect(m.refundStatusOf(stored), name).toBe(expected);
        const row = await raw(client, job.id);
        expect(row.refund_status, name).toBe(expected);
        expect(row.status).toBe(status);
        // The house reads it; a workspace that pays in credits does not (a take's billing today: lib/providerOutcome.ts takeFailure).
        expect(finished.refundStatus, name).toBe(ws.id === HOUSE ? expected : null);
        // Our words, never the vendor's.
        expect(String(row.error_public)).not.toMatch(/synthetic|memory|overload|engine-a3/i);
        expect(String(row.error_public).length).toBeGreaterThan(0);
      }
      // No outcome, or one that cannot be read: "the provider didn't say". A finished-done job has none.
      for (const value of [null, undefined, "", "not json", JSON.stringify({ v: 2 })]) expect(m.refundStatusOf(value as never)).toBe("unknown");
      const bare = await store.createJob({ productionId: "prj_one", decider: "agent", product: "reading", quote, by: "usr_person" });
      expect((await store.finish(bare.id, "cancelled")).error).toBe("Cancelled");
      expect((await raw(client, bare.id)).refund_status).toBe("unknown");
    });
  }
});

test("nothing billed changes: a job's whole life writes no row anywhere but the two new tables, and reads the actual from the meter's receipt", async () => {
  const m = await mods();
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace("ws_credit_money", "money");
  const client = await existingDatabase(ws);
  await approval(client, "rpa_synthetic", "prj_one", SYNTHETIC_CREDITS * 10);
  const tenantBefore = await snapshot(client);
  const platformBefore = await snapshot(platformDb());
  const job = await m.runInTenant(ws, async () => {
    const store = m.jobStoreForTests(client, ws.id);
    const command = await store.createCommand({ productionId: "prj_one", instruction: "Synthetic instruction", quote: { credits: SYNTHETIC_CREDITS }, by: "usr_person" });
    await store.approveCommand(command.id, "rpa_synthetic", PERSON);
    await store.moveCommand(command.id, "running", { runRef: "run_rpa_synthetic" });
    const made = await store.createJob({ productionId: "prj_one", commandId: command.id, decider: "agent", product: "generation", engine: SYNTHETIC_ENGINE, quote: { credits: SYNTHETIC_CREDITS }, by: "usr_person" });
    await store.start(made.id);
    await store.attach(made.id, { meterId: "gen_money", takeId: "gen_money" });
    await store.finish(made.id, "failed", (await outcomeFixtures())[0].outcome);
    await store.moveCommand(command.id, "failed");
    return made;
  });
  expect(await snapshot(client)).toBe(tenantBefore);
  expect(await snapshot(platformDb())).toBe(platformBefore);

  // The actual is the meter's (its workspace replica), never a column of the job: a receipt appears, the job reads it.
  await client.execute({ sql: "INSERT INTO credit_receipts(event_id,credits,revision) VALUES('gen_money',?,1)", args: [SYNTHETIC_RECEIPT] });
  await m.runInTenant(ws, async () => {
    const store = m.jobStoreForTests(client, ws.id);
    expect((await store.get(job.id))?.actual).toEqual({ credits: SYNTHETIC_RECEIPT });
  });

  // The new code imports nothing that reserves, meters, settles or charges, and no paid path imports it.
  const { readFileSync } = await import("node:fs");
  for (const file of ["lib/quotedJobs/store.ts", "lib/quotedJobs/vocabulary.ts", "lib/quotedJobs/flag.ts", "lib/jobView.ts"]) {
    const imports = [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((x) => x[1]);
    for (const spec of imports) expect(spec, file).not.toMatch(/meter|generationRequests|generationAdmission|billingLedger|creditReceipts|reconcile|topups|platformSpend|allowance|paidText|stripe/i);
  }
});

test("commands: written with their quote, approved by a person against a real approval, and their total is the sum of their jobs' receipts", async () => {
  const m = await mods();
  const ws = workspace("ws_credit_commands", "commands");
  const client = await existingDatabase(ws, "prj_one", "prj_two");
  const QUOTE = SYNTHETIC_CREDITS + 2 * SYNTHETIC_CREDITS_B;
  await m.runInTenant(ws, async () => {
    const store = m.jobStoreForTests(client, ws.id);
    await expect(store.createCommand({ productionId: "prj_one", instruction: "  ", quote: { credits: SYNTHETIC_CREDITS }, by: "u" })).rejects.toMatchObject({ status: 400 });
    await expect(store.createCommand({ productionId: "prj_one", instruction: "x", quote: undefined as never, by: "u" })).rejects.toMatchObject({ status: 400 });
    await expect(store.createCommand({ productionId: "prj_one", instruction: "x", quote: { usd: SYNTHETIC_USD } as never, by: "u" })).rejects.toMatchObject({ status: 400 });
    const command = await store.createCommand({ productionId: "prj_one", instruction: "  Synthetic: make three shots  ", quote: { credits: QUOTE }, by: "agent:run_1" });
    expect(command).toMatchObject({ state: "quoted", instruction: "Synthetic: make three shots", quote: { credits: QUOTE }, total: { credits: 0 }, jobs: 0 });

    // A job of an instruction nobody approved is refused.
    const job = (credits: number, commandId = command.id) => store.createJob({ productionId: "prj_one", commandId, decider: "agent", product: "generation", quote: { credits }, by: "agent:run_1" });
    await expect(job(SYNTHETIC_CREDITS)).rejects.toMatchObject({ status: 409 });

    // Approving spend is a person's alone: Atomik, a machine id, an API token, nobody or a disabled person are refused.
    const quoteTenths = QUOTE * 10;
    await approval(client, "rpa_1", "prj_one", quoteTenths);
    const machines = [
      { user: { id: "agent:run_1" } }, { user: { id: "server" } }, { user: { id: "mcp:client_1" } }, { user: { id: "worker:1" } }, { user: { id: "auto" } },
      { user: { id: " usr_person" } }, { user: { id: "usr_person" }, token: { id: "tok" } }, { user: null }, { user: { id: "usr_off", disabled: true } },
    ];
    for (const caller of machines) await expect(store.approveCommand(command.id, "rpa_1", caller), JSON.stringify(caller)).rejects.toBeInstanceOf(m.PeopleOnlyError);
    // The approval must exist, be of the same production, be open, and cover the quote.
    await approval(client, "rpa_other_production", "prj_two", quoteTenths);
    await approval(client, "rpa_closed", "prj_one", quoteTenths, { closed: true });
    await approval(client, "rpa_expired", "prj_one", quoteTenths, { expiresAt: Date.now() - 1 });
    await approval(client, "rpa_short", "prj_one", quoteTenths - 1);
    await expect(store.approveCommand(command.id, "rpa_missing", PERSON)).rejects.toMatchObject({ status: 404 });
    await expect(store.approveCommand(command.id, "rpa_other_production", PERSON)).rejects.toMatchObject({ status: 404 });
    await expect(store.approveCommand(command.id, "rpa_closed", PERSON)).rejects.toMatchObject({ status: 409 });
    await expect(store.approveCommand(command.id, "rpa_expired", PERSON)).rejects.toMatchObject({ status: 409 });
    await expect(store.approveCommand(command.id, "rpa_short", PERSON)).rejects.toMatchObject({ status: 409 });
    await expect(store.moveCommand(command.id, "running")).rejects.toMatchObject({ status: 409 });
    await expect(store.moveCommand(command.id, "approved" as never)).rejects.toMatchObject({ status: 400 });
    expect((await store.getCommand(command.id))?.state).toBe("quoted");
    await expect(client.execute({ sql: "UPDATE agent_commands SET state='running' WHERE id=?", args: [command.id] })).rejects.toThrow(/CHECK/i);
    // Someone else's approval is refused, even for a person.
    await approval(client, "rpa_someone_else", "prj_one", quoteTenths, { approvedBy: "usr_other" });
    await expect(store.approveCommand(command.id, "rpa_someone_else", PERSON)).rejects.toMatchObject({ status: 403 });
    const approved = await store.approveCommand(command.id, "rpa_1", PERSON);
    expect(approved.state).toBe("approved");
    await expect(store.approveCommand(command.id, "rpa_1", PERSON)).rejects.toMatchObject({ status: 409 });
    // One approval approves one command: a second command on the same approval is refused, by the store and the table.
    const second = await store.createCommand({ productionId: "prj_one", instruction: "Synthetic: the same plan again", quote: { credits: QUOTE }, by: "usr_person" });
    await expect(store.approveCommand(second.id, "rpa_1", PERSON)).rejects.toMatchObject({ status: 409 });
    await expect(client.execute({ sql: "UPDATE agent_commands SET state='approved', approval_ref='rpa_1' WHERE id=?", args: [second.id] })).rejects.toThrow(/UNIQUE/i);
    expect((await store.getCommand(second.id))?.state).toBe("quoted");
    // The command takes the approval's run; another run cannot carry it on.
    expect((await client.execute({ sql: "SELECT run_ref FROM agent_commands WHERE id=?", args: [command.id] })).rows[0].run_ref).toBe("run_rpa_1");
    await expect(client.execute({ sql: "UPDATE agent_commands SET approval_ref='rpa_other' WHERE id=?", args: [command.id] })).rejects.toThrow(/keeps its words/);
    await expect(client.execute({ sql: "UPDATE agent_commands SET quote_tenths=1 WHERE id=?", args: [command.id] })).rejects.toThrow(/keeps its words/);

    // Its jobs: Agent jobs of the same production only, and only inside the command's quote.
    await expect(store.createJob({ productionId: "prj_one", commandId: command.id, decider: "director", product: "generation", quote: { credits: 1 }, by: "u" })).rejects.toMatchObject({ status: 400 });
    await expect(store.createJob({ productionId: "prj_two", commandId: command.id, decider: "agent", product: "generation", quote: { credits: 1 }, by: "u" })).rejects.toMatchObject({ status: 404 });
    await expect(job(1, "acmd_missing")).rejects.toMatchObject({ status: 404 });
    await expect(job(QUOTE + 0.1)).rejects.toMatchObject({ status: 409 });
    const one = await job(SYNTHETIC_CREDITS);
    await expect(store.moveCommand(command.id, "running", { runRef: "run_other" })).rejects.toMatchObject({ status: 409 });
    expect((await store.getCommand(command.id))?.state).toBe("approved");
    await expect(client.execute({ sql: "UPDATE agent_commands SET run_ref='run_other' WHERE id=?", args: [command.id] })).rejects.toThrow(/keeps its words/);
    await store.moveCommand(command.id, "running", { runRef: "run_rpa_1" });
    const two = await job(SYNTHETIC_CREDITS_B);
    const three = await job(SYNTHETIC_CREDITS_B);
    // The three fill the quote exactly: one more, however small, does not fit.
    await expect(job(0.1)).rejects.toMatchObject({ status: 409 });
    await store.attach(one.id, { meterId: "gen_c1" });
    await store.attach(two.id, { meterId: "gen_c2" });
    await store.attach(three.id, { meterId: "gen_c3" });
    // Receipts the meter replicated (synthetic), one of them for a job of nobody's command.
    for (const [event, credits] of [["gen_c1", SYNTHETIC_RECEIPT], ["gen_c2", SYNTHETIC_RECEIPT_B], ["gen_unrelated", 99]] as const)
      await client.execute({ sql: "INSERT INTO credit_receipts(event_id,credits,revision) VALUES(?,?,1)", args: [event, credits] });
    const read = await store.getCommand(command.id);
    expect(read).toMatchObject({ jobs: 3, total: { credits: SYNTHETIC_RECEIPT + SYNTHETIC_RECEIPT_B }, quote: { credits: QUOTE } });
    expect((await store.listCommands("prj_one")).map((c) => c.id).sort()).toEqual([command.id, second.id].sort());
    expect((await store.list({ commandId: command.id })).map((j) => j.id).sort()).toEqual([one.id, two.id, three.id].sort());
    const done = await store.moveCommand(command.id, "done");
    expect(done.state).toBe("done");
    await expect(job(0)).rejects.toMatchObject({ status: 409 });
    await expect(store.moveCommand(command.id, "failed")).rejects.toMatchObject({ status: 409 });
    await expect(client.execute({ sql: "UPDATE agent_commands SET state='failed' WHERE id=?", args: [command.id] })).rejects.toThrow(/keeps its words/);

    // A declined or cancelled instruction takes no job either.
    for (const end of ["declined", "cancelled"] as const) {
      const other = await store.createCommand({ productionId: "prj_one", instruction: `Synthetic ${end}`, quote: { credits: QUOTE }, by: "usr_person" });
      await store.moveCommand(other.id, end);
      await expect(job(1, other.id)).rejects.toMatchObject({ status: 409 });
    }
  });

  // The house is quoted in credits like every workspace (at cost); it has no credit receipts, so no credit total.
  const house = workspace(HOUSE, "commands-house");
  const houseClient = await existingDatabase(house);
  await m.runInTenant(house, async () => {
    const store = m.jobStoreForTests(houseClient, house.id);
    await expect(store.createCommand({ productionId: "prj_one", instruction: "Synthetic", quote: { usd: SYNTHETIC_USD } as never, by: "usr_person" })).rejects.toMatchObject({ status: 400 });
    const command = await store.createCommand({ productionId: "prj_one", instruction: "Synthetic", quote: { credits: SYNTHETIC_CREDITS }, by: "usr_person" });
    expect(command).toMatchObject({ quote: { credits: SYNTHETIC_CREDITS }, total: null });
  });
});

test("flag off: refused before the workspace database is opened, no table is created, and nothing in the app reaches the store", async () => {
  const m = await mods();
  const fresh = workspace(HOUSE, "house-never-opened");
  const existing = workspace(HOUSE, "house-off");
  const client = await existingDatabase(existing);
  const before = await snapshot(client);
  for (const value of [undefined, "", "0", "true", "on", " 1", "1 "]) {
    await withFlag(value, async () => {
      expect(m.jobsSwitchOn()).toBe(false);
      expect(await m.jobsOn(fresh)).toBe(false);
      for (const ws of [fresh, existing])
        await m.runInTenant(ws, async () => {
          await expect(m.quotedJobs()).rejects.toBeInstanceOf(m.JobsOffError);
        });
    });
  }
  expect(existsSync(fileOf("house-never-opened"))).toBe(false);
  const reopened = m.tenantClient(existing);
  expect((await schemaNames(reopened)).filter((n) => /quoted_jobs|agent_commands/.test(n))).toEqual([]);
  expect(await snapshot(reopened)).toBe(before);

  // Switch on: still off for a workspace without the new interface, and for no workspace at all.
  await withFlag("1", async () => {
    expect(await m.jobsOn(workspace("ws_customer"))).toBe(false);
    expect(await m.jobsOn(null)).toBe(false);
    expect(await m.jobsOn(fresh)).toBe(true);
    await m.runInTenant(workspace("ws_customer", "customer-never-opened"), async () => {
      await expect(m.quotedJobs()).rejects.toBeInstanceOf(m.JobsOffError);
    });
  });
  expect(existsSync(fileOf("customer-never-opened"))).toBe(false);
  // (No file in app/ or components/ importing the store or the serializer is checked by tests/unit/jobEngineGuard.spec.ts.)
});

test("tenant isolation: workspace B cannot read or write workspace A's jobs or commands by id, even through a store pointed at A's database", async () => {
  const m = await mods();
  const a = workspace(HOUSE, "iso-a");
  const b = workspace("ws_iso_b", "iso-b");
  const clientA = await existingDatabase(a, "prj_a");
  const clientB = await existingDatabase(b, "prj_b");

  // B is on the new interface too, through the platform owner's list: merged into the site row, restored afterwards.
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const previous = (await platformDb().execute("SELECT value, updated_at, updated_by FROM platform_layer WHERE key='site'")).rows[0];
  const site = previous ? (JSON.parse(String(previous.value)) as Record<string, unknown>) : {};
  const listed = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
  await platformDb().execute({
    sql: `INSERT INTO platform_layer(key,value,updated_at,updated_by) VALUES('site',?,?,'test')
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [JSON.stringify({ ...site, newInterfaceWorkspaces: [b.id, ...listed.filter((id) => id !== b.id)] }), Date.now()],
  });

  try {
    await withFlag("1", async () => {
      const made = await m.runInTenant(a, async () => {
        const store = await m.quotedJobs();
        expect(store.workspaceId).toBe(a.id);
        const created = await store.createCommand({ productionId: "prj_a", instruction: "Synthetic A", quote: { credits: SYNTHETIC_CREDITS }, by: "usr_a" });
        await approval(clientA, "rpa_iso_a", "prj_a", SYNTHETIC_CREDITS * 10);
        const command = await store.approveCommand(created.id, "rpa_iso_a", { user: { id: "usr_person" } });
        const job = await store.createJob({ productionId: "prj_a", commandId: command.id, decider: "agent", product: "generation", engine: SYNTHETIC_ENGINE, quote: { credits: SYNTHETIC_CREDITS }, by: "usr_a" });
        const queued = await store.createJob({ productionId: "prj_a", decider: "director", product: "reading", engine: SYNTHETIC_ENGINE, quote: { credits: SYNTHETIC_CREDITS }, by: "usr_a" });
        await store.attach(job.id, { meterId: "gen_iso_a" });
        return { command, job, queued };
      });
      const rowsA = async () => JSON.stringify([
        ...(await clientA.execute("SELECT * FROM quoted_jobs ORDER BY id")).rows,
        ...(await clientA.execute("SELECT * FROM agent_commands ORDER BY id")).rows,
      ]);
      const before = await rowsA();

      const tryAll = async (store: Awaited<ReturnType<typeof m.quotedJobs>>) => {
        // Written in A, invisible from B: the same answer as for a job that does not exist.
        expect(await store.get(made.job.id)).toBeNull();
        expect(await store.getCommand(made.command.id)).toBeNull();
        expect(await store.list({ productionId: "prj_a" })).toEqual([]);
        expect(await store.list({ commandId: made.command.id })).toEqual([]);
        expect(await store.list()).toEqual([]);
        expect(await store.listCommands("prj_a")).toEqual([]);
        expect(await store.csv()).toBe(`${(await import("../../lib/jobView")).JOB_CSV_HEADER.join(",")}\n`);
        expect(await store.errorLine(made.job.id)).toBeNull();
        expect(await store.recipe(made.job.id)).toBeNull();
        await expect(store.start(made.queued.id)).rejects.toMatchObject({ status: 404, message: "That job is not in this workspace." });
        await expect(store.finish(made.job.id, "failed")).rejects.toMatchObject({ status: 404 });
        await expect(store.attach(made.queued.id, { meterId: "gen_b" })).rejects.toMatchObject({ status: 404 });
        await expect(store.approveCommand(made.command.id, "rpa_b", { user: { id: "usr_b" } })).rejects.toMatchObject({ status: 404 });
        await expect(store.approveCommand(made.command.id, "rpa_iso_a", { user: { id: "usr_b" } })).rejects.toMatchObject({ status: 404 });
        await expect(store.moveCommand(made.command.id, "cancelled")).rejects.toMatchObject({ status: 404 });
        // A's command and production cannot be written into.
        await expect(store.createJob({ productionId: "prj_a", decider: "agent", product: "generation", quote: { credits: 1 }, by: "usr_b" })).rejects.toMatchObject({ status: 404 });
        await expect(store.createJob({ commandId: made.command.id, decider: "agent", product: "generation", quote: { credits: 1 }, by: "usr_b" })).rejects.toMatchObject({ status: 404 });
        await expect(store.createCommand({ productionId: "prj_a", instruction: "x", quote: { credits: 1 }, by: "usr_b" })).rejects.toMatchObject({ status: 404 });
      };

      // Through the real entry point, in B's scope, on B's database.
      await m.runInTenant(b, async () => {
        const store = await m.quotedJobs();
        expect(store.workspaceId).toBe(b.id);
        await tryAll(store);
      });
      // A store built for B but pointed at A's database: still nothing of A's.
      await m.runInTenant(b, async () => {
        await tryAll(m.jobStoreForTests(clientA, b.id));
      });
      // The same store in A's scope is refused outright; with no workspace in scope, too.
      await m.runInTenant(a, async () => {
        const crossed = m.jobStoreForTests(clientA, b.id);
        await expect(crossed.get(made.job.id)).rejects.toMatchObject({ status: 403 });
        await expect(crossed.createJob({ decider: "agent", product: "generation", quote: { credits: 1 }, by: "x" })).rejects.toMatchObject({ status: 403 });
        await expect(crossed.ready()).rejects.toMatchObject({ status: 403 });
      });
      await expect(m.jobStoreForTests(clientA, a.id).get(made.job.id)).rejects.toBeInstanceOf(m.NoTenantError);

      expect(await rowsA()).toBe(before);
      expect((await schemaNames(clientB)).filter((n) => n === "quoted_jobs")).toHaveLength(1);
      expect(Number((await clientB.execute("SELECT COUNT(*) AS n FROM quoted_jobs")).rows[0].n)).toBe(0);
    });
  } finally {
    if (previous)
      await platformDb().execute({ sql: "UPDATE platform_layer SET value=?, updated_at=?, updated_by=? WHERE key='site'", args: [previous.value, previous.updated_at, previous.updated_by] });
    else await platformDb().execute("UPDATE platform_layer SET value='{}' WHERE key='site'");
  }
});
