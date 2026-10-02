import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import { seedCollectedOriginal } from "../helpers/consumerLedger";

/**
 * A collected connected-account original records its length (the gap the live
 * qualification found on 20 September 2026).
 *
 * `gen_hfc_…` — a video generated on the connected account and collected into a
 * project — could be stored with `generations.duration_s` NULL. Every tool that
 * prices per second reads that column, so a per-second quote refused the
 * workspace's own video with "This video has no stored duration. Re-upload it",
 * advice a collected original cannot follow. Nothing collects an account
 * original any more (its sign-in was removed), but the ones already in the
 * Library still need a length: an original stored without one is measured on
 * first read and written back.
 *
 * No paid call: the original is seeded as the old collector left it.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-collected-duration-"));
process.env.PLATFORM_DATABASE_URL = `file:${directory}/platform.db`;
process.env.KEYRING_SECRET ??= "collected-duration-unit-keyring-not-real";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const original = readFileSync("tests/fixtures/astra-source.mp4");
/** The fixture clip's real length, as the MP4 inspection reads it. */
const SECONDS = 1.5;
const saved: string[] = [];
test.afterAll(async () => {
  await Promise.all(
    saved.map((id) => unlink(path.join(process.cwd(), ".data/generations", `${id}.mp4`)).catch(() => {})),
  );
});

function workspace(): TenantWorkspace {
  const id = `collected-duration-${randomUUID()}`;
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${directory}/${id}.db`, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, ownerId: "owner", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null,
    rendersPerHour: null, storageQuotaBytes: original.length * 8, deletedAt: null,
  };
}

test("resolveStoredDuration backfills a collected original that was stored without a length, and the column answers next time", async () => {
  const database = await import("../../lib/db");
  const tenant = await import("../../lib/tenant");
  const media = await import("../../lib/mediaSource.server");
  await tenant.runInTenant(workspace(), async () => {
    await database.ready();
    const draftId = `draft-${randomUUID()}`, productionId = `project-${randomUUID()}`;
    await database.db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Fixture',0)", args: [productionId] });
    const collected = await seedCollectedOriginal({ userId: "owner", draftId, bytes: original, projectId: productionId, completed: true });
    saved.push(collected.generationId);
    // Exactly the row shape the live qualification left behind.
    await database.db().execute({ sql: "UPDATE generations SET duration_s=NULL WHERE id=?", args: [collected.generationId] });
    const source = (await media.findStoredSource({ genId: collected.generationId }))!;
    expect(source).toMatchObject({ kind: "generation", mediaKind: "video", ext: "mp4", seconds: null });
    const resolved = await media.resolveStoredDuration(source);
    expect(resolved.seconds).toBeCloseTo(SECONDS, 3);
    const persisted = (await database.db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [collected.generationId] })).rows[0];
    expect(Number(persisted.duration_s)).toBeCloseTo(SECONDS, 3);
    // Second read is a column read: the stored value is returned unchanged.
    expect((await media.resolveStoredDuration((await media.findStoredSource({ genId: collected.generationId }))!)).seconds).toBeCloseTo(SECONDS, 3);
  });
});
