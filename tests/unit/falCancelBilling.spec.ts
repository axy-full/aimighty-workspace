import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * What a fal take is CHARGED after a cancel was asked of fal (owner's decisions on #639), on the real sync path and ledger event,
 * with the vendor's poll stubbed (no provider is called). The charge is the settlement event the take's outcome writes:
 * `engineCostUsd: 0` is a free, confirmed outcome; `null` is an unconfirmed one, which keeps the hold and is charged.
 *  (a) free only on an explicit cancel signal; a 404 or 410 is not one.
 *  (b) a running job stopped after a 202: no video back is free; fal answering with an error is charged.
 *  (c) a cancel that was tried and not confirmed, then a 404: charged, and filed once for the owner to review.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-fal-cancel-billing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "fal-cancel-billing-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });

const HOURS = 60 * 60_000;
const ENDPOINT = "fal-ai/kling-video/v3";

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

type Poll = () => Promise<{ status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; videoUrl: string | null; totalTokens: number | null; error: string | null; vendorStartedAt: null; vendorEndedAt: null; raw: unknown }>;

/** Runs `body` in a fresh workspace with a fal take at the provider, whose poll says what `poll` says. */
async function scenario(
  poll: Poll,
  take: { params?: Record<string, unknown>; ageMs?: number },
  body: (ctx: { id: string; sync: () => Promise<{ status: string }>; charge: () => Promise<number | null | "none">; row: () => Promise<{ status: string }>; reviews: () => Promise<Record<string, unknown>[]> }) => Promise<void>,
) {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  await platformReady();
  const name = `fal_${randomUUID().slice(0, 8)}`;
  const ws = workspace(name);
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)", args: [`grant_${name}`, ws.id, Date.now()] });
  const engine = engineFor("fal"), original = engine.poll;
  engine.poll = poll;
  try {
    await runInTenant(ws, async () => {
      await ready();
      const id = `gen_${name}`;
      const at = Date.now() - (take.ageMs ?? 5 * 60_000);
      await db().execute({
        sql: `INSERT INTO generations(id,provider,model,prompt,params,status,created_at,updated_at) VALUES(?,'fal','fal-ai/kling-video/v3/standard','a boat',?,'queued',?,?)`,
        args: [id, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, falRequestId: `req_${name}`, falModel: ENDPOINT, ...(take.params ?? {}) }), at, at],
      });
      await body({
        id,
        sync: async () => syncGeneration((await getGeneration(id))!),
        row: async () => ({ status: String((await db().execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0].status) }),
        charge: async () => {
          const r = (await db().execute({ sql: "SELECT event FROM generation_settlements WHERE id=?", args: [id] })).rows[0];
          return r ? (JSON.parse(String(r.event)).engineCostUsd ?? null) : "none";
        },
        reviews: async () => (await platformDb().execute({ sql: "SELECT id, url, reason, details, workspace_id FROM reports WHERE url=?", args: [`/api/generations/${id}/cancel`] })).rows as unknown as Record<string, unknown>[],
      });
    });
  } finally {
    engine.poll = original;
  }
}

const noVideo: Poll = async () => ({ status: "failed", videoUrl: null, totalTokens: null, error: "The render service finished without a video.", vendorStartedAt: null, vendorEndedAt: null, raw: {} });
const throwing = (error: Error): Poll => async () => { throw error; };

test("(b) a running job stopped after a 202 that returns no video is free", async () => {
  await scenario(noVideo, {}, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBe(0);
  });
});

test("(b) a job fal answers with an error for is charged: it keeps its hold and ends unconfirmed, never free", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  const error = new FalHttpError(500, "The render service returned 500.", null);
  /* Still within the ceiling: another pass, nothing settled, nothing free. */
  await scenario(throwing(error), {}, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "queued" });
    expect(await t.charge()).toBe("none");
  });
  /* Past the ceiling: it ends, and the charge is not confirmed (null), so it is charged. */
  await scenario(throwing(error), { ageMs: 7 * HOURS }, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBeNull();
  });
});

test("a refusal (422) stays free, per the existing rule", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  await scenario(throwing(new FalHttpError(422, "The render service returned 422: refused.", { detail: [{ type: "content_policy_violation" }] })), {}, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBe(0);
  });
});

test("(a) an explicit cancellation after a cancel was asked is free and ends cancelled; a 404 or a 410 is not free", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  const asked = { cancelRequestedAt: 1 };
  await scenario(throwing(new FalHttpError(400, "The render service returned 400: Request was cancelled.", { detail: "Request was cancelled." })), { params: asked }, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "cancelled" });
    expect(await t.charge()).toBe(0);
  });
  /* A 404 with the cancel accepted: today's path, unconfirmed, charged. */
  await scenario(throwing(new FalHttpError(404, "The render service returned 404: not found.", null)), { params: asked }, async (t) => {
    await t.sync();
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBeNull();
  });
  /* A 410 is not a cancel signal either: it is not read as free, and the take is not cancelled. */
  await scenario(throwing(new FalHttpError(410, "The render service returned 410: gone.", null)), { params: asked }, async (t) => {
    await t.sync();
    expect(await t.row()).not.toEqual({ status: "cancelled" });
    expect(await t.charge()).not.toBe(0);
  });
});

const TRAIL = { at: 1_000, put: { at: 1_001, kind: "timeout", status: null, text: "The operation was aborted due to timeout" }, after: { at: 1_002, kind: "http", status: 404, text: "The render service returned 404: not found." } };

test("(c) a cancel that timed out, then a 404: charged (unconfirmed), and filed exactly once, even when two polls overlap", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  await scenario(throwing(new FalHttpError(404, "The render service returned 404: not found.", null)), { params: { cancelTrail: TRAIL } }, async (t) => {
    await Promise.all([t.sync(), t.sync()]);
    await t.sync();
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBeNull();
    const rows = await t.reviews();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe(`rp_cancel_${t.id}`);
    const details = JSON.parse(String(rows[0].details));
    expect(details).toMatchObject({ jobId: t.id, provider: "fal", cancelAccepted: false, cancelAsked: { kind: "timeout" }, afterCancel: { status: 404 }, gone: { status: 404 } });
  });
});

test("a 404 with no cancel attempt on record is charged as before and files nothing", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  await scenario(throwing(new FalHttpError(404, "The render service returned 404: not found.", null)), {}, async (t) => {
    await t.sync();
    expect(await t.charge()).toBeNull();
    expect(await t.reviews()).toHaveLength(0);
  });
});

test("filing that fails changes nothing about the charge: the same take, with the desk's table gone, ends the same way", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  const { platformDb } = await import("../../lib/platform");
  await scenario(throwing(new FalHttpError(404, "The render service returned 404: not found.", null)), { params: { cancelTrail: TRAIL } }, async (t) => {
    await platformDb().execute("ALTER TABLE reports RENAME TO reports_away");
    try {
      await t.sync();
      expect(await t.row()).toEqual({ status: "failed" });
      expect(await t.charge()).toBeNull();
    } finally {
      await platformDb().execute("ALTER TABLE reports_away RENAME TO reports");
    }
    expect(await t.reviews()).toHaveLength(0);
  });
});

test("(c) a ledger step that throws after the outcome is written does not lose the note: still filed once, and the charge is the same", async () => {
  const { FalHttpError } = await import("../../lib/fal");
  const { platformDb } = await import("../../lib/platform");
  await scenario(throwing(new FalHttpError(404, "The render service returned 404: not found.", null)), { params: { cancelTrail: TRAIL } }, async (t) => {
    /* The meter refuses writes for a moment: the settlement after the outcome cannot be delivered (critical), and the sync throws. */
    await platformDb().execute("CREATE TRIGGER blip_meter_insert BEFORE INSERT ON meter_events BEGIN SELECT RAISE(ABORT, 'platform database blip'); END");
    await platformDb().execute("CREATE TRIGGER blip_meter_update BEFORE UPDATE ON meter_events BEGIN SELECT RAISE(ABORT, 'platform database blip'); END");
    try {
      await t.sync().then(() => undefined, () => undefined);
    } finally {
      await platformDb().execute("DROP TRIGGER blip_meter_insert");
      await platformDb().execute("DROP TRIGGER blip_meter_update");
    }
    /* The outcome was written (unconfirmed: charged), and the case is on the desk exactly once. */
    expect(await t.row()).toEqual({ status: "failed" });
    expect(await t.charge()).toBeNull();
    expect(await t.reviews()).toHaveLength(1);
    await t.sync();
    expect(await t.reviews()).toHaveLength(1);
  });
});
