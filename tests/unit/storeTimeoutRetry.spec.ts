import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatedSha256, startFakeProvider, type FakeProvider } from "../helpers/fake-provider-server";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * "If a provider video save times out, the save is retried from the provider
 * later, and a paid render is never lost."
 *
 * The real lib/jobs.ts path, end to end: syncGeneration sees a succeeded task,
 * takes the store lease and calls the real storeVideo against a local fake
 * provider file host; the save times out; the row is kept as a success on the
 * provider's URL; the cron sweep (syncPending) finds it and stores it.
 *
 * The only stub is the BytePlus engine's poll (the vendor's status answer),
 * exactly as tests/unit/arkVideoDuration.spec.ts does. storeVideo is real,
 * storage is local disk, the provider file is served by
 * tests/helpers/fake-provider-server.ts. Nothing is paid, nothing leaves the host.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-store-retry-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "store-retry-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.STORAGE_BACKEND = "local";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

test.describe.configure({ mode: "serial" });

const MiB = 1024 * 1024;
const SIZE = 4 * MiB + 321;
const MODEL = "dreamina-seedance-2-0-260128";
const TOKENS = 244_800;
const LOCAL_DIR = path.join(process.cwd(), ".data", "generations");

let provider: FakeProvider;
const stored: string[] = [];

test.beforeAll(async () => {
  /* Before any fixture row: a fresh platform database counts in today's price (lib/ledgerUnit.ts). */
  await alignLedgerUnit();
  provider = await startFakeProvider();
});
test.afterAll(async () => {
  await provider?.close();
  await Promise.all(stored.map((id) => unlink(path.join(LOCAL_DIR, `${id}.mp4`)).catch(() => {})));
  rmSync(dir, { recursive: true, force: true });
});

function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {},
    usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 1, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

async function setup(prefix: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const name = `${prefix}_${randomUUID().slice(0, 8)}`;
  const ws = workspace(name);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)",
    args: [`grant_${name}`, ws.id, Date.now()],
  });
  return ws;
}

/** A paid, running Seedance row with its credits reserved, as admission leaves one. */
async function running(id: string) {
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  await ready();
  await db().execute({
    sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,ark_task_id,created_at,updated_at)
          VALUES(?,'video','byteplus',?,'a plain bottle',?,'running',?,?,?)`,
    args: [id, MODEL, JSON.stringify({ duration: 5, resolution: "720p", ratio: "16:9", paidClaim: Date.now() }), `ark_${id}`, Date.now(), Date.now()],
  });
  await reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: MODEL, status: "running", engineCostUsd: 1 });
  stored.push(id);
}

async function row(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({
    sql: "SELECT status, source_url, stored_url, cost_usd, total_tokens, bytes, error, provider_outcome, json_extract(params,'$.storeUntil') AS store_until FROM generations WHERE id=?",
    args: [id],
  })).rows[0];
  return {
    status: r.status, source_url: r.source_url, stored_url: r.stored_url, error: r.error,
    provider_outcome: r.provider_outcome, store_until: r.store_until,
    total_tokens: r.total_tokens == null ? null : Number(r.total_tokens),
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    bytes: r.bytes == null ? null : Number(r.bytes),
  };
}

/** What the ledger says about this job: one meter event, and what it bills. */
async function bill(wsId: string, id: string) {
  const { platformDb } = await import("../../lib/platform");
  const rs = await platformDb().execute({
    sql: "SELECT status, engine_cost_usd, billed_credits FROM meter_events WHERE workspace_id=? AND id=?",
    args: [wsId, id],
  });
  return rs.rows.map((r) => ({ status: String(r.status), engineCostUsd: Number(r.engine_cost_usd), billedCredits: Number(r.billed_credits) }));
}

async function credits(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  const state = await creditStateFor(ws);
  return { used: state?.used, balance: state?.balance };
}

/** The vendor's answer to a poll: succeeded, with whatever file URL `current()` names. */
function delivering(current: () => string) {
  return async () => ({
    status: "succeeded" as const,
    videoUrl: current(),
    totalTokens: TOKENS,
    error: null,
    vendorStartedAt: null,
    vendorEndedAt: null,
    raw: {},
  });
}

/** lib/recovery.ts records every storage write; one it cannot prove harmless stays 'uncertain'. */
async function unsettledActivities() {
  const { platformDb } = await import("../../lib/platform");
  const rs = await platformDb().execute("SELECT kind, state FROM recovery_activities WHERE state != 'done'");
  return rs.rows.map((r) => ({ kind: String(r.kind), state: String(r.state) }));
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const leftovers = (id: string) => (existsSync(LOCAL_DIR) ? readdirSync(LOCAL_DIR).filter((f) => f.includes(id)) : []);

test("a save that times out keeps the paid render on the provider URL, billed exactly as a normal success", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { getGeneration, syncGeneration, syncPending } = await import("../../lib/jobs");
  const engine = engineFor("byteplus"), poll = engine.poll;
  const full = provider.url(SIZE);
  const stalling = provider.url(SIZE, { stallAfter: MiB });
  let current = full;
  engine.poll = delivering(() => current);
  try {
    // The control: the same job whose save goes through first time.
    const control = await setup("store_ok");
    const controlId = `gen_store_ok_${randomUUID().slice(0, 8)}`;
    const normal = await runInTenant(control, async () => {
      await running(controlId);
      await syncGeneration((await getGeneration(controlId))!, { strict: true });
      return { row: await row(controlId), bill: await bill(control.id, controlId), credits: await credits(control) };
    });
    expect(normal.row).toMatchObject({ status: "succeeded", stored_url: `ws/${control.id}/generations/${controlId}.mp4`, bytes: SIZE });
    expect(normal.row.cost_usd).toBeGreaterThan(0);
    expect(normal.bill).toHaveLength(1);
    expect(normal.bill[0].status).toBe("succeeded");
    expect(normal.bill[0].billedCredits).toBeGreaterThan(0);
    expect(normal.credits.used).toBe(normal.bill[0].billedCredits);

    const ws = await setup("store_timeout");
    const id = `gen_store_timeout_${randomUUID().slice(0, 8)}`;
    await runInTenant(ws, async () => {
      await running(id);

      // 1. The vendor says succeeded; its file sends 1 MiB and stalls. The save times out.
      current = stalling;
      const requestsBefore = provider.requests;
      const started = Date.now();
      const seen = await syncGeneration((await getGeneration(id))!, { store: { timeoutMs: 500, maxQueueMs: 5_000 } });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(provider.requests).toBe(requestsBefore + 1);

      // The render is kept: a success, playable from the provider's URL, not failed.
      expect(seen.status).toBe("succeeded");
      expect(seen.sourceUrl).toBe(stalling);
      expect(seen.storedUrl).toBeNull();
      const kept = await row(id);
      expect(kept).toMatchObject({ status: "succeeded", source_url: stalling, stored_url: null, error: null, provider_outcome: null, bytes: null, total_tokens: TOKENS });
      // The lease is handed back with the failure: the next poll may try at once.
      expect(kept.store_until).toBeNull();
      // Nothing half-written is left as the master.
      expect(leftovers(id)).toEqual([]);
      // And the recovery fence holds no uncertain storage write for it.
      expect(await unsettledActivities()).toEqual([]);

      // Billed once, at the same figure and the same credits as the normal success:
      // no refund for a render the customer has, and no second charge.
      expect(kept.cost_usd).toBe(normal.row.cost_usd);
      expect(await bill(ws.id, id)).toEqual(normal.bill);
      expect(await credits(ws)).toEqual(normal.credits);

      // 2. Later the provider serves the whole file, and the cron sweep picks the row up.
      current = full;
      const sweep = await syncPending(10);
      expect(sweep.failed).toBe(0);
      expect(provider.requests).toBe(requestsBefore + 2);

      const saved = await row(id);
      expect(saved).toMatchObject({
        status: "succeeded", source_url: full, stored_url: `ws/${ws.id}/generations/${id}.mp4`,
        bytes: SIZE, error: null, total_tokens: TOKENS, store_until: null,
      });
      // The stored bytes are the provider's file, byte for byte, through the real read path.
      const { readVideoBytes } = await import("../../lib/storage");
      const bytes = await readVideoBytes(id);
      expect(bytes.length).toBe(SIZE);
      expect(sha256(bytes)).toBe(generatedSha256(SIZE));
      expect(sha256(readFileSync(path.join(LOCAL_DIR, `${id}.mp4`)))).toBe(generatedSha256(SIZE));
      expect(leftovers(id)).toEqual([`${id}.mp4`]);

      // Same cost, same single bill, same credits: the retry charged nothing more.
      expect(saved.cost_usd).toBe(normal.row.cost_usd);
      expect(await bill(ws.id, id)).toEqual(normal.bill);
      expect(await credits(ws)).toEqual(normal.credits);

      // 3. Sealed: a further sweep neither selects nor downloads it again.
      await syncPending(10);
      expect(provider.requests).toBe(requestsBefore + 2);
      expect(await row(id)).toEqual(saved);
    });
  } finally {
    engine.poll = poll;
  }
});

test("a save lease left by a crashed poller blocks retries only until it runs out", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { db } = await import("../../lib/db");
  const { getGeneration, syncGeneration, syncPending } = await import("../../lib/jobs");
  const engine = engineFor("byteplus"), poll = engine.poll;
  const full = provider.url(SIZE);
  engine.poll = delivering(() => full);
  try {
    const ws = await setup("store_lease");
    const id = `gen_store_lease_${randomUUID().slice(0, 8)}`;
    await runInTenant(ws, async () => {
      await running(id);
      // A poller took the lease and died mid-save: the row is still running and unsaved.
      await db().execute({
        sql: "UPDATE generations SET params=json_set(params,'$.storeUntil',?) WHERE id=?",
        args: [Date.now() + 60_000, id],
      });
      const requestsBefore = provider.requests;
      await syncGeneration((await getGeneration(id))!, { store: { timeoutMs: 5_000 } });
      // Someone else's lease: no download, nothing written, nothing lost.
      expect(provider.requests).toBe(requestsBefore);
      expect(await row(id)).toMatchObject({ status: "running", stored_url: null });

      // Time passes the lease (STORE_LEASE_MS after it was taken); the sweep saves it.
      await db().execute({
        sql: "UPDATE generations SET params=json_set(params,'$.storeUntil',?) WHERE id=?",
        args: [Date.now() - 1, id],
      });
      expect((await syncPending(10)).failed).toBe(0);
      expect(provider.requests).toBe(requestsBefore + 1);
      const saved = await row(id);
      expect(saved).toMatchObject({ status: "succeeded", stored_url: `ws/${ws.id}/generations/${id}.mp4`, bytes: SIZE, store_until: null });
      expect(saved.cost_usd).toBeGreaterThan(0);
      const { readVideoBytes } = await import("../../lib/storage");
      expect(sha256(await readVideoBytes(id))).toBe(generatedSha256(SIZE));
      const ledger = await bill(ws.id, id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe("succeeded");
    });
  } finally {
    engine.poll = poll;
  }
});
