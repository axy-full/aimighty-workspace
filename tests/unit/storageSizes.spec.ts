import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadIsolated } from "./storageSeam";

/* The cron's size backfill (lib/storageCost.ts): it must measure what can be
   measured, skip what has nothing to measure, and fail only when storage
   could not answer. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-storage-sizes-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

test("demo takes are never looked up, a missing object is skipped rather than failing the run, and a 3D model is read from its own key", async () => {
  const tenant = await import("../../lib/tenant");
  const dbModule = await import("../../lib/db");
  const lookups: string[] = [];
  let unreachable = false;
  const { backfillSizes, SIZE_MISS_RETRY_MS } = loadIsolated<typeof import("../../lib/storageCost")>("lib/storageCost.ts", {
    "./db": dbModule,
    "./storage": {
      originalSize: async (kind: string, id: string) => {
        lookups.push(`${kind}:${id}`);
        if (unreachable && id === "gen_video") throw new Error("storage unreachable");
        return id === "gen_gone" ? null : id === "gen_model" ? 2048 : 4096;
      },
    },
  });
  const ws = { id: "sizes", name: "Sizes", slug: "sizes", legacy: false, dbUrl: `file:${path.join(dir, "sizes.db")}`, dbToken: null, keys: {}, usesPlatformKeys: false } as unknown as import("../../lib/tenant").TenantWorkspace;
  await tenant.runInTenant(ws, async () => {
    const { db, ready } = dbModule;
    await ready();
    const insert = (id: string, kind: string, stored: string, at: number) => db().execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,kind,created_at,updated_at) VALUES(?,?,?,'{}','succeeded',?,?,?,?)`,
      args: [id, "fixture-model", "p", stored, kind, at, at],
    });
    for (let i = 0; i < 6; i++) await insert(`gen_demo_${i}`, "video", i % 2 ? "/fixtures/clip.mp4" : `/api/platform/previews/move%3Apush${i}`, 100 + i);
    await insert("gen_gone", "video", "/api/media/gen_gone", 50);
    await insert("gen_model", "model", "/api/media/gen_model", 40);
    await insert("gen_video", "video", "/api/media/gen_video", 30);

    const at = Date.now();
    expect(await backfillSizes(8, at)).toBe(2);
    expect(lookups.sort()).toEqual(["model:gen_model", "video:gen_gone", "video:gen_video"]);
    const bytes = Object.fromEntries((await db().execute(`SELECT id, bytes FROM generations WHERE id IN ('gen_model','gen_video','gen_gone')`)).rows.map((r) => [String(r.id), r.bytes]));
    expect(bytes).toEqual({ gen_model: 2048, gen_video: 4096, gen_gone: null });

    // The missing object is not looked up again on the next visit…
    lookups.length = 0;
    expect(await backfillSizes(8, at + 1)).toBe(0);
    expect(lookups).toEqual([]);
    // …until a week has passed.
    expect(await backfillSizes(8, at + SIZE_MISS_RETRY_MS + 1)).toBe(0);
    expect(lookups).toEqual(["video:gen_gone"]);

    // Storage that cannot answer still fails the stage, so the cron says so.
    await db().execute(`UPDATE generations SET bytes = NULL WHERE id = 'gen_video'`);
    unreachable = true;
    await expect(backfillSizes(8, at + 2)).rejects.toThrow("STORAGE_SIZE_LOOKUP_FAILED");
  });
});
