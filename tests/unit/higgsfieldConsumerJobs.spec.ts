import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { seedConsumerJob } from "../helpers/consumerLedger";

/**
 * The connected account's job ledger, read-only (lib/higgsfield-consumer/jobs.ts).
 * Particl no longer signs in to Higgsfield, so nothing quotes, sends, polls or
 * collects an account job; the rows a database already holds are read as they
 * stand, and none is ever deleted. Rows are seeded the way an older database
 * holds them (tests/helpers/consumerLedger.ts).
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-jobs-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-consumer-ledger-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `ledger-${++sequence}`;
  return {
    id: name,
    slug: name,
    name,
    legacy: true,
    dbUrl: `file:${path.join(directory, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
const owner = { userId: "owner", draftId: "draft" };
async function modules() {
  return {
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
  };
}
async function seedDraft(userId = owner.userId, draftId = owner.draftId) {
  const { database } = await modules();
  await database.ready();
  await database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,'{}',1,?)",
    args: [`${userId}-${draftId}`, userId, draftId, "Test draft", Date.now()],
  });
}

test("the module reads the ledger and writes no row: no quote, send, poll, collection, slot count or set-aside is left", async () => {
  const { jobs } = await modules();
  expect(Object.keys(jobs).filter((name) => typeof (jobs as Record<string, unknown>)[name] === "function").sort()).toEqual([
    "ConsumerJobError", "consumerJobsReady", "getConsumerJob", "listConsumerJobs",
  ]);
  /* The one figure the tray still reads: how long an open job counts as current. */
  expect(jobs.CONSUMER_CAPACITY_WINDOW_MS).toBe(2 * 3_600_000);
  expect(readFileSync("lib/higgsfield-consumer/jobs.ts", "utf8")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b[^`]*higgsfield_consumer_jobs/);
});

test("a fresh database gets every column, and an older table gains the later ones without losing a row", async () => {
  const { tenant, jobs, database } = await modules();
  await tenant.runInTenant(workspace(), async () => {
    await database.ready();
    /* The first shape the ledger shipped with: no receipt, set-aside, sweep or outcome columns. */
    await database.db().execute(`CREATE TABLE higgsfield_consumer_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, draft_id TEXT NOT NULL,
      connected_owner_id TEXT NOT NULL, connection_generation TEXT NOT NULL, higgsfield_workspace_id TEXT,
      workflow TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, immutable_hash TEXT NOT NULL,
      quote_credits REAL NOT NULL, quote_expires_at INTEGER NOT NULL, original_asset_ids TEXT NOT NULL,
      status TEXT NOT NULL, provider_job_id TEXT, dispatch_claim_hash TEXT, poll_lease_hash TEXT, poll_lease_until INTEGER,
      result_manifest TEXT, failure_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    await database.db().execute(`INSERT INTO higgsfield_consumer_jobs VALUES('old-job','owner','draft','owner','generation-1',NULL,'genjutsu','old-key',
      '{"input":{"prompt":"An old run"}}','payload','immutable',12.5,0,'[]','completed','11111111-1111-4111-8111-111111111111','claim',NULL,NULL,'{"original":{"bytes":1}}',NULL,10,20)`);
    await jobs.consumerJobsReady();
    const columns = (await database.db().execute("PRAGMA table_info(higgsfield_consumer_jobs)")).rows.map((row) => String(row.name));
    expect(columns).toEqual(expect.arrayContaining(["provider_receipt", "released_at", "swept_at", "provider_outcome"]));
    expect(await jobs.getConsumerJob({ ...owner, id: "old-job" })).toMatchObject({
      status: "completed", workflow: "genjutsu", quoteCredits: 12.5, creditUnit: "higgsfield_credits",
      resultManifest: { original: { bytes: 1 } }, providerReceipt: null, providerOutcome: null, releasedAt: null,
    });
  });
  await tenant.runInTenant(workspace(), async () => {
    await jobs.consumerJobsReady();
    const columns = (await database.db().execute("PRAGMA table_info(higgsfield_consumer_jobs)")).rows.map((row) => String(row.name));
    expect(columns).toEqual(expect.arrayContaining(["dispatch_claim_hash", "provider_receipt", "released_at", "swept_at", "provider_outcome"]));
  });
});

test("owner, draft and tenant boundaries protect every read", async () => {
  const { tenant, jobs } = await modules(),
    first = workspace(),
    second = workspace();
  let id = "";
  await tenant.runInTenant(first, async () => {
    await seedDraft();
    id = await seedConsumerJob({ ...owner, status: "completed" });
    expect((await jobs.getConsumerJob({ ...owner, id }))?.id).toBe(id);
    for (const wrong of [
      { userId: "other-owner", draftId: "draft" },
      { userId: "owner", draftId: "other-draft" },
    ]) {
      expect(await jobs.getConsumerJob({ ...wrong, id })).toBeNull();
      expect((await jobs.listConsumerJobs(wrong)).items).toEqual([]);
    }
    await expect(jobs.getConsumerJob({ ...owner, id: "has space" })).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(jobs.listConsumerJobs({ ...owner, limit: 51 })).rejects.toMatchObject({ code: "invalid_input" });
  });
  await tenant.runInTenant(second, async () => {
    await seedDraft();
    expect(await jobs.getConsumerJob({ ...owner, id })).toBeNull();
    expect((await jobs.listConsumerJobs(owner)).items).toEqual([]);
  });
  await expect(jobs.getConsumerJob({ ...owner, id })).rejects.toThrow("No workspace");
});

test("the list pages by a stable cursor, reads no claim or fingerprint, and keeps a deleted draft's jobs", async () => {
  const { tenant, jobs, database } = await modules();
  await tenant.runInTenant(workspace(), async () => {
    await seedDraft();
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push(await seedConsumerJob({ ...owner, status: index ? "completed" : "accepted", createdAt: 1_000 + index }));
    const first = await jobs.listConsumerJobs({ ...owner, limit: 2 });
    const second = await jobs.listConsumerJobs({ ...owner, limit: 2, before: first.nextCursor! });
    const third = await jobs.listConsumerJobs({ ...owner, limit: 2, before: second.nextCursor! });
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((job) => job.id)).toEqual([...ids].reverse());
    expect(JSON.stringify(first)).not.toMatch(/lease_hash|dispatch_claim|immutable_hash|claim-/);
    await database.db().execute({ sql: "DELETE FROM workbench_projects WHERE owner=? AND project_id=?", args: [owner.userId, owner.draftId] });
    expect((await jobs.listConsumerJobs(owner)).items).toHaveLength(5);
    expect((await jobs.getConsumerJob({ ...owner, id: ids[0] }))?.status).toBe("accepted");
  });
});
