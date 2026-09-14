import { RECOVERY_PROTOCOL } from "../../lib/recovery/control.mjs";
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = mkdtempSync(path.join(tmpdir(), "particl-drain-fixture-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "recovery-drain-fixture-keyring-32-characters";
process.env.ENGINE_MOCK = "1";

for (const budgetExpires of [false, true])
  test(
    budgetExpires
      ? "elapsed cron budget leaves the next accepted intent untouched and no activity behind"
      : "maintenance cron settles an exact accepted provider job without releasing held or legacy jobs",
    async () => {
      const { platformReady, platformDb, getWorkspace } =
        await import("../../lib/platform");
      const { ready, db } = await import("../../lib/db");
      const { runInTenant } = await import("../../lib/tenant");
      const { reserveGenerationSpend } =
        await import("../../lib/generationRequests");
      const { recoveryFence } = await import("../../lib/recovery");
      const { drainRecoveryJobs } = await import("../../lib/recoveryDrain");
      const { engineFor } = await import("../../lib/engines");
      // The full unit worker reuses the platform module initialized by earlier
      // fixtures. Bind the coordinator to that actual disposable SQLite database,
      // not a later test file's process.env assignment made during collection.
      const previousPlatformUrl = process.env.PLATFORM_DATABASE_URL;
      const activeFile = (
        await platformDb().execute(
          "SELECT file FROM pragma_database_list WHERE name='main'",
        )
      ).rows[0].file;
      process.env.PLATFORM_DATABASE_URL = `file:${activeFile}`;
      await platformReady();
      const workspaceId = budgetExpires ? "ws_drain_budget" : "ws_drain";
      await platformDb().execute({
        sql: `INSERT INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?, ?,0,0,'owner',0,0)`,
        args: [
          workspaceId,
          workspaceId,
          "Drain",
          `file:${path.join(directory, workspaceId + ".db")}`,
        ],
      });
      const ws = (await getWorkspace(workspaceId))!;
      await runInTenant(ws, async () => {
        await ready();
        for (const [id, status] of [
          ["accepted", "running"],
          ["accepted_next", "running"],
          ["held", "held"],
          ["legacy", "running"],
        ])
          await db().execute({
            sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,ark_task_id,cost_usd,stored_url,created_at,updated_at) VALUES(?,'video','byteplus','mock','fixture','{}',?,'existing-handle',0.4,'saved-master',?,?)`,
            args: [
              id.startsWith("accepted") ? id + "_" + workspaceId : id,
              status,
              Date.now(),
              Date.now(),
            ],
          });
        for (const id of [
          "accepted_" + workspaceId,
          "accepted_next_" + workspaceId,
        ])
          await reserveGenerationSpend({
            id,
            kind: "video",
            engine: "byteplus",
            model: "mock",
            status: "running",
            engineCostUsd: 1,
          });
      });
      const fence = recoveryFence();
      // Run this fixture first without touching any other fixture intent.
      await platformDb().execute({
        sql: "UPDATE recovery_intents SET created_at=-1 WHERE workspace_id=?",
        args: [workspaceId],
      });
      // Make the first saved-handle video deterministically first in this fixture.
      await platformDb().execute({
        sql: "UPDATE recovery_intents SET created_at=-2 WHERE workspace_id=? AND id=?",
        args: [workspaceId, "accepted_" + workspaceId],
      });
      const earlierIntents = (await fence.status()).intents.length - 1;
      await fence.begin("drain-fixture-owner-0123456789012345", {
        deployments: [{ id: "local", protocol: RECOVERY_PROTOCOL }],
        oldDeploymentsStopped: true,
        externalWritersExcluded: true,
        evidence:
          "Only disposable local fixtures are reachable; the engine is replaced by a deterministic status stub.",
      });
      const engine = engineFor("byteplus"),
        original = engine.poll;
      let polls = 0,
        at = 1000;
      engine.poll = async () => {
        polls++;
        if (budgetExpires) at += 30_000;
        return {
          status: "succeeded",
          videoUrl: "https://unused.invalid/master",
          totalTokens: 999,
          error: null,
          vendorStartedAt: null,
          vendorEndedAt: null,
          raw: {},
        };
      };
      try {
        const report = await drainRecoveryJobs(budgetExpires ? 8 : 1, {
          clock: () => at,
          deadlineAt: 291_000,
        });
        expect(report).toEqual({
          attempted: 1,
          failed: 0,
          remaining: earlierIntents,
          deferred: budgetExpires,
        });
        expect(
          (await fence.status()).activities.filter(
            (row: { workspace_id: string }) => row.workspace_id === workspaceId,
          ),
        ).toEqual([]);
        expect(
          (
            await platformDb().execute({
              sql: "SELECT id FROM recovery_intent_attempts WHERE workspace_id=? AND id=?",
              args: [workspaceId, "accepted_next_" + workspaceId],
            })
          ).rows,
        ).toEqual([]);
        expect(polls).toBe(1);
        const native = await import("../../lib/localDatabaseClient");
        const tenant = native.createPlatformDatabaseClient({ url: ws.dbUrl });
        expect(
          (
            await tenant.execute(
              "SELECT id,status FROM generations ORDER BY id",
            )
          ).rows.map((r) => [r.id, r.status]),
        ).toEqual([
          ["accepted_next_" + workspaceId, "running"],
          ["accepted_" + workspaceId, "succeeded"],
          ["held", "held"],
          ["legacy", "running"],
        ]);
        expect(
          (
            await platformDb().execute({
              sql: "SELECT status FROM meter_events WHERE id=?",
              args: ["accepted_" + workspaceId],
            })
          ).rows[0].status,
        ).toBe("succeeded");
        expect(
          (
            await tenant.execute({
              sql: "SELECT settled_at FROM generation_settlements WHERE id=?",
              args: ["accepted_" + workspaceId],
            })
          ).rows[0].settled_at,
        ).not.toBeNull();
      } finally {
        engine.poll = original;
        const state = await fence.status();
        if (state.state !== "open")
          await fence.reopen(
            "drain-fixture-owner-0123456789012345",
            Number(state.epoch),
          );
        process.env.PLATFORM_DATABASE_URL = previousPlatformUrl;
      }
    },
  );
