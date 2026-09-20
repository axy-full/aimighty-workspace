import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import path from "node:path";

/**
 * A demo take is NON-QUOTABLE, and its length is never invented.
 *
 * The starter production's takes (lib/starter.ts) are inserted already
 * `succeeded` with a `stored_url` of `demoMediaUrl(...)` — a shared platform
 * preview, or the shipped `public/fixtures/clip.mp4`. Neither is a stored
 * original of the workspace, so neither bounded inspector can open one: they
 * resolve a generation's bytes under the workspace's own Blob prefix, and there
 * are no such bytes for a demo row. The row does carry `params.duration` from
 * `DEMO_TAKES`, but that is a fixture number, and a per-second price off a
 * fixture is a wrong bill.
 *
 * So: `duration_s` stays NULL, nothing measures or backfills it, and every
 * per-second admission refuses the take with the reason instead of pricing it.
 *
 * No paid call: nothing here reaches a vendor, and no render path runs.
 */
const dir = mkdtempSync("/private/tmp/demo-duration-");
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "demo-duration-unit-keyring-not-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const originalFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async () => { throw new Error("Unexpected external request in test"); }; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

/** One workspace of this run, with its own database file. */
async function workspace(name: string) {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformReady();
  const id = `demo-duration-${name}`;
  await platformDb().execute({
    sql: `INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`],
  });
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

/** The seeded demo takes, as the workspace's database holds them. */
async function demoRows() {
  const { db, ready } = await import("../../lib/db");
  const { seedStarterProduction } = await import("../../lib/starter");
  await ready();
  await seedStarterProduction("owner");
  const rows = (await db().execute(
    `SELECT id, kind, status, stored_url, bytes, duration_s, params FROM generations ORDER BY created_at ASC`,
  )).rows as unknown as { id: string; kind: string; status: string; stored_url: string; bytes: number | null; duration_s: number | null; params: string }[];
  expect(rows.length).toBeGreaterThanOrEqual(6);
  return rows;
}

test("the demo takes are seeded with no measured length and no stored bytes, and never with the fixture duration", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("seed"), async () => {
    const rows = await demoRows();
    const { DEMO_TAKES, isDemoMediaUrl } = await import("../../lib/demoProduction");
    const fixtureDurations = new Set(DEMO_TAKES.map((t) => t.duration));
    expect(fixtureDurations.size).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("succeeded");
      expect(row.kind).toBe("video");
      // The picture is demo media, not one of this workspace's stored originals.
      expect(isDemoMediaUrl(row.stored_url)).toBe(true);
      expect(row.stored_url.startsWith("/api/media/")).toBe(false);
      // Nothing sealed these rows, so nothing measured them.
      expect(row.duration_s).toBeNull();
      expect(row.bytes).toBeNull();
      // params.duration is a fixture, and it stayed in params.
      const params = JSON.parse(row.params) as { duration?: number; demo?: boolean };
      expect(params.demo).toBe(true);
      expect(fixtureDurations.has(Number(params.duration))).toBe(true);
    }
  });
});

test("a demo take is refused per-second pricing with its reason, and reading its length persists nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("refuse"), async () => {
    const rows = await demoRows();
    const { db } = await import("../../lib/db");
    const { findStoredSource, resolveStoredDuration, DEMO_SOURCE_REASON } = await import("../../lib/mediaSource.server");
    const source = (await findStoredSource({ genId: rows[0].id }))!;
    // It is findable — a demo take is visible in the workspace, it is just not measurable.
    expect(source).toMatchObject({ kind: "generation", mediaKind: "video", demo: true, seconds: null });

    const verdict = await resolveStoredDuration(source);
    expect(verdict.seconds).toBeNull();
    expect(verdict.reason).toBe(DEMO_SOURCE_REASON);
    // The lazy measure-and-persist backfill must not have written a length.
    expect((await db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [rows[0].id] })).rows[0].duration_s).toBeNull();

    // And the guard holds ahead of the column, so a length written onto the row
    // by anything other than a render path still cannot be quoted.
    await db().execute({ sql: "UPDATE generations SET duration_s=? WHERE id=?", args: [5, rows[0].id] });
    const again = (await findStoredSource({ genId: rows[0].id }))!;
    expect(again.seconds).toBe(5);
    expect(await resolveStoredDuration(again)).toEqual({ seconds: null, reason: DEMO_SOURCE_REASON });
    await db().execute({ sql: "UPDATE generations SET duration_s=NULL WHERE id=?", args: [rows[0].id] });
  });
});

test("the per-minute admissions refuse a demo take rather than quote it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("dub"), async () => {
    const rows = await demoRows();
    const { DEMO_SOURCE_REASON } = await import("../../lib/mediaSource.server");
    const { resolveDubbingSource } = await import("../../lib/dubbing");
    const refusal = await resolveDubbingSource({ sourceGenId: rows[0].id });
    expect(refusal).toMatchObject({ status: 422 });
    expect("error" in refusal && refusal.error).toContain(DEMO_SOURCE_REASON);
  });
});
