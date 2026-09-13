import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-audio-spend-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

for (const rejected of [false, true])
  test(
    rejected
      ? "definitively rejected audio releases its reservation"
      : "ambiguous audio failure never retries the provider and retains its reserve",
    async () => {
      const { platformReady, platformDb, rowToWorkspace, grantCredits } =
        await import("../../lib/platform");
      const { runInTenant } = await import("../../lib/tenant");
      const { db, ready } = await import("../../lib/db");
      const { reserveGenerationSpend } =
        await import("../../lib/generationRequests");
      const { billingStateFor } = await import("../../lib/billingLedger");
      const { loadJob, produce } = await import("../../lib/renderWork");
      const { engineFor } = await import("../../lib/engines");
      const { ElevenLabsError } = await import("../../lib/elevenlabs");
      await platformReady();
      const id = rejected ? "audio-rejected" : "audio-uncertain";
      await platformDb().execute({
        sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)`,
        args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
      });
      await grantCredits(id, 100, "Test funds", "owner", "manual");
      const ws = rowToWorkspace(
        (
          await platformDb().execute({
            sql: "SELECT * FROM workspaces WHERE id=?",
            args: [id],
          })
        ).rows[0],
      );
      const engine = engineFor("elevenlabs"),
        original = engine.render;
      let calls = 0;
      engine.render = async () => {
        calls++;
        throw rejected
          ? new ElevenLabsError(422, "Invalid input")
          : new Error("Connection lost after submission");
      };
      try {
        await runInTenant(ws, async () => {
          await ready();
          await db().execute({
            sql: `INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'audio','eleven_sfx','rain',?,'running',?,?)`,
            args: [
              id,
              JSON.stringify({ task: "sound", estCredits: 200 }),
              Date.now(),
              Date.now(),
            ],
          });
          await reserveGenerationSpend({
            id,
            kind: "audio",
            engine: "elevenlabs",
            model: "eleven_sfx",
            status: "running",
            engineCostUsd: 0.0364,
          });
          expect((await billingStateFor(id)).credits.balance).toBe(99);
          const job = (await loadJob(id))!;
          await expect(produce(job)).rejects.toThrow(
            rejected ? "Invalid input" : "Connection lost",
          );
          expect(await produce(job)).toBeNull();
          expect(calls).toBe(1);
          expect((await billingStateFor(id)).credits.balance).toBe(
            rejected ? 100 : 99,
          );
          const row = (
            await db().execute({
              sql: "SELECT status,cost_usd FROM generations WHERE id=?",
              args: [id],
            })
          ).rows[0];
          expect(row.status).toBe("failed");
          expect(Number(row.cost_usd)).toBe(rejected ? 0 : 0.0364);
        });
      } finally {
        engine.render = original;
      }
    },
  );

test("a queued job whose funding source changed releases its reservation without calling the provider", async () => {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } =
    await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } =
    await import("../../lib/generationRequests");
  const { billingStateFor } = await import("../../lib/billingLedger");
  const { loadJob, produce } = await import("../../lib/renderWork");
  const { engineFor } = await import("../../lib/engines");
  await platformReady();
  const engine = engineFor("elevenlabs"),
    original = engine.render;
  let calls = 0;
  engine.render = async () => {
    calls++;
    throw new Error("The changed funding source must be checked first.");
  };
  try {
    for (const initiallyPaid of [true, false]) {
      const id = initiallyPaid ? "audio-key-added" : "audio-key-removed";
      await platformDb().execute({
        sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)",
        args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
      });
      await grantCredits(id, 100, "Test funds", "owner", "manual");
      const paid = rowToWorkspace(
        (
          await platformDb().execute({
            sql: "SELECT * FROM workspaces WHERE id=?",
            args: [id],
          })
        ).rows[0],
      );
      const own = { ...paid, keys: { elevenlabs: "test-own-key" } };
      await runInTenant(initiallyPaid ? paid : own, async () => {
        await ready();
        await db().execute({
          sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'audio','eleven_sfx','rain','{}','running',?,?)",
          args: [id, Date.now(), Date.now()],
        });
        await reserveGenerationSpend({
          id,
          kind: "audio",
          engine: "elevenlabs",
          model: "eleven_sfx",
          status: "running",
          engineCostUsd: 0.0364,
        });
      });
      expect((await billingStateFor(id)).credits.balance).toBe(
        initiallyPaid ? 99 : 100,
      );
      await runInTenant(initiallyPaid ? own : paid, async () => {
        const job = (await loadJob(id))!;
        await expect(produce(job)).rejects.toThrow("credentials changed");
        expect(await produce(job)).toBeNull();
        expect(
          (
            await db().execute({
              sql: "SELECT status,cost_usd FROM generations WHERE id=?",
              args: [id],
            })
          ).rows[0],
        ).toMatchObject({ status: "failed", cost_usd: 0 });
      });
      expect((await billingStateFor(id)).credits.balance).toBe(100);
    }
    expect(calls).toBe(0);
  } finally {
    engine.render = original;
  }
});
