import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The main Studio video path records the length it delivered.
 *
 * `lib/jobs.ts` seals every Ark/BytePlus video: it copies the MP4 into our own
 * storage and snapshots the cost. Until now it wrote no `duration_s`, so every
 * Ark video in the library carried NULL, and the only length anywhere near the
 * row was `params.duration` — what was ASKED for, never what came back. The two
 * differ: the mocked engine here is asked for 5 seconds and delivers a 10-second
 * clip, which is exactly the case a requested-duration column would get wrong.
 *
 * Reframe / Shorts / dubbing survived the NULL because
 * `resolveStoredDuration()` measures lazily and backfills, but that made the
 * first quote of every Ark video a bounded storage read instead of a column
 * read. Measuring once at the seal, from the bytes just stored, is the fix.
 *
 * Best effort is asserted too: a file whose length cannot be read still seals,
 * still bills, and leaves `duration_s` NULL for the lazy backfill — a
 * measurement is never allowed to unsettle a render that is safely stored.
 *
 * No paid call: the engine's poll is stubbed and the master is a local fixture.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-ark-duration-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "ark-duration-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

/** public/fixtures/clip.mp4, as the bounded inspector reads it. */
const DELIVERED_SECONDS = 10;
/** What the composer asked for, and what `params.duration` therefore says. */
const REQUESTED_SECONDS = 5;

const stored: string[] = [];
test.afterAll(async () => {
  await Promise.all(
    stored.map((id) =>
      unlink(path.join(process.cwd(), ".data", "generations", `${id}.mp4`)).catch(() => {}),
    ),
  );
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

async function setup(name: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace(name);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,1000,'test',?)",
    args: [`grant_${name}`, ws.id, Date.now()],
  });
  return ws;
}

/** A running Ark video row, exactly as `lib/generationAdmission.ts` leaves one:
 *  no `kind`, so the schema default 'video' applies, and no duration column. */
async function queued(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO generations(id,provider,model,prompt,params,status,ark_task_id,created_at,updated_at)
          VALUES(?,'byteplus','mock','a plain bottle',?,'running',?,?,?)`,
    args: [
      id,
      JSON.stringify({ duration: REQUESTED_SECONDS, resolution: "720p", ratio: "16:9" }),
      `ark_${id}`,
      Date.now(),
      Date.now(),
    ],
  });
  stored.push(id);
}

/** The vendor said "succeeded" and handed back this master. Nothing is paid. */
function delivering(master: string) {
  return async () => ({
    status: "succeeded" as const,
    videoUrl: master,
    totalTokens: 244_800,
    error: null,
    vendorStartedAt: null,
    vendorEndedAt: null,
    raw: {},
  });
}

async function row(id: string) {
  const { db } = await import("../../lib/db");
  return (
    await db().execute({
      sql: "SELECT status, stored_url, bytes, kind, duration_s, total_tokens FROM generations WHERE id=?",
      args: [id],
    })
  ).rows[0];
}

test("a sealed Ark video records the length it delivered, not the length that was asked for", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { fixtureUrl } = await import("../../lib/mock");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  const { findStoredSource, resolveStoredDuration } = await import("../../lib/mediaSource.server");
  const engine = engineFor("byteplus"), poll = engine.poll;
  engine.poll = delivering(fixtureUrl("clip.mp4"));
  try {
    await runInTenant(await setup(`ark_delivered_${randomUUID().slice(0, 8)}`), async () => {
      const id = `gen_ark_delivered`;
      await queued(id);
      const sealed = await syncGeneration((await getGeneration(id))!, { strict: true });
      expect(sealed.status).toBe("succeeded");
      // FAILS ON origin/main: the seal wrote no duration_s at all.
      expect(sealed.durationS).toBe(DELIVERED_SECONDS);
      const persisted = await row(id);
      expect(persisted).toMatchObject({ kind: "video", status: "succeeded" });
      expect(Number(persisted.duration_s)).toBeCloseTo(DELIVERED_SECONDS, 3);
      // The delivered length, which is NOT what params.duration says.
      expect(Number(persisted.duration_s)).not.toBe(REQUESTED_SECONDS);
      // Millisecond rounding, the same shape the fal and genjutsu seals write.
      expect(Number(persisted.duration_s)).toBe(Math.round(Number(persisted.duration_s) * 1000) / 1000);
      // And the per-second tools now read a column instead of the storage.
      const source = (await findStoredSource({ genId: id }))!;
      expect(source.seconds).toBeCloseTo(DELIVERED_SECONDS, 3);
      expect((await resolveStoredDuration(source)).seconds).toBeCloseTo(DELIVERED_SECONDS, 3);
      // A second pass over a sealed row leaves the recorded length alone.
      await syncGeneration((await getGeneration(id))!);
      expect(Number((await row(id)).duration_s)).toBeCloseTo(DELIVERED_SECONDS, 3);
    });
  } finally {
    engine.poll = poll;
  }
});

test("a length that cannot be measured still seals and still bills, leaving duration_s NULL for the backfill", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { engineFor } = await import("../../lib/engines");
  const { fixtureUrl } = await import("../../lib/mock");
  const { getGeneration, syncGeneration } = await import("../../lib/jobs");
  const engine = engineFor("byteplus"), poll = engine.poll;
  // Bytes that store fine and carry no readable video track.
  engine.poll = delivering(fixtureUrl("still.png"));
  try {
    await runInTenant(await setup(`ark_unreadable_${randomUUID().slice(0, 8)}`), async () => {
      const id = `gen_ark_unreadable`;
      await queued(id);
      // strict: a measurement failure must not surface as a render failure.
      const sealed = await syncGeneration((await getGeneration(id))!, { strict: true });
      expect(sealed.status).toBe("succeeded");
      expect(sealed.durationS).toBeNull();
      const persisted = await row(id);
      expect(persisted.status).toBe("succeeded");
      expect(persisted.duration_s).toBeNull();
      // The vendor's usage snapshot is untouched by the missing length.
      expect(Number(persisted.total_tokens)).toBe(244_800);
      expect(persisted.stored_url).toBe(`/api/media/${id}`);
    });
  } finally {
    engine.poll = poll;
  }
});
