import { recoveryFence, withRecoveryJob } from "./recovery";
import { getWorkspace } from "./platform";
import { db, ready } from "./db";
import { runInTenant } from "./tenant";
import { getGeneration, syncGeneration } from "./jobs";
import { runInline } from "./renderWork";
import { submitVideoRow } from "./submitVideo";
import { syncIdentity, getIdentity, reconcileFalRender } from "./identities";
import { syncSoulIdentity } from "./soulIdentities";
import { runAtomikJob } from "./workbench/atomik-server";
import { runDevelopmentStep } from "./workbench/development-server";

/** The maintenance cron may only continue exact intents accepted before the
 * fence. It cannot create a job, release a held row, provision or purge. A
 * missing legacy intent, lost process activity or uncertain result stays loud. */
export const RECOVERY_DRAIN_JOB_BUDGET_MS = 270_000;
export const RECOVERY_DRAIN_WORK_BUDGET_MS = 290_000;
export async function drainRecoveryJobs(
  limit = 8,
  options: { deadlineAt?: number; clock?: () => number } = {},
) {
  const clock = options.clock ?? Date.now;
  const deadlineAt =
    options.deadlineAt ?? clock() + RECOVERY_DRAIN_WORK_BUDGET_MS;
  const state = await recoveryFence().status();
  if (state.state !== "draining")
    return {
      attempted: 0,
      failed: 0,
      remaining: state.intents.length,
      deferred: false,
    };
  let attempted = 0,
    failed = 0;
  let deferred = false;
  const visited: { workspaceId: string; id: string }[] = [];
  for (let index = 0; index < Math.max(1, Math.min(20, limit)); index++) {
    // Do not mark or admit another intent unless one full slow operation fits.
    // In particular, an image adapter may spend 240s waiting for its provider.
    if (clock() + RECOVERY_DRAIN_JOB_BUDGET_MS > deadlineAt) {
      deferred = true;
      break;
    }
    const [intent] = await recoveryFence().takeDrainIntents(1, visited);
    if (!intent) break;
    visited.push({
      workspaceId: String(intent.workspace_id),
      id: String(intent.id),
    });
    attempted++;
    try {
      const workspaceId = String(intent.workspace_id),
        jobId = String(intent.id);
      await withRecoveryJob(workspaceId, jobId, async () => {
        const ws = await getWorkspace(workspaceId);
        if (!ws || ws.deletedAt)
          throw new Error("Recovery job workspace unavailable.");
        await runInTenant(ws, async () => {
          await ready();
          if (["image", "audio", "video"].includes(String(intent.kind))) {
            const job = await getGeneration(jobId);
            if (!job || job.status === "held")
              throw new Error("Recovery intent has no accepted generation.");
            if (job.kind === "video") {
              if (["running", "queued"].includes(job.status) && !job.arkTaskId)
                await submitVideoRow(jobId);
              const current = await getGeneration(jobId);
              if (current) await syncGeneration(current, { strict: true });
            } else {
              if (
                job.provider === "fal" &&
                typeof job.params.falRequestId === "string"
              ) {
                await reconcileFalRender(
                  {
                    id: jobId,
                    requestId: job.params.falRequestId,
                    createdAt: job.createdAt,
                    seed:
                      typeof job.params.seed === "number"
                        ? job.params.seed
                        : null,
                  },
                  { strict: true },
                );
                return;
              }
              if (job.params.identity)
                throw new Error(
                  "An identity render without a saved handle needs its original admitted continuation; do not reinterpret it as an ordinary image.",
                );
              await runInline(jobId);
              const current = await getGeneration(jobId);
              if (current) await syncGeneration(current, { strict: true });
            }
            return;
          }
          const tables = new Set(
            (
              await db().execute(
                "SELECT name FROM sqlite_schema WHERE type='table'",
              )
            ).rows.map((r) => String(r.name)),
          );
          if (intent.kind === "training") {
            if (tables.has("soul_identities") && (await db().execute({ sql: "SELECT id FROM soul_identities WHERE id=?", args: [jobId] })).rows.length) {
              await syncSoulIdentity(jobId);
              return;
            }
            const row = (
              await db().execute({
                sql: "SELECT id FROM identities WHERE training_run_id=?",
                args: [jobId],
              })
            ).rows[0];
            const identity = row ? await getIdentity(String(row.id)) : null;
            if (!identity)
              throw new Error("Recovery training intent unavailable.");
            await syncIdentity(identity);
            return;
          }
          if (intent.kind === "text" && tables.has("workbench_development_jobs")) {
            const row = (await db().execute({
              sql: "SELECT owner,status FROM workbench_development_jobs WHERE id=?",
              args: [jobId],
            })).rows[0];
            if (row) {
              // Suspension blocks new paid phases. Releasing an interrupted
              // admission or settling a saved terminal result is still safe.
              if (ws.suspendedAt && row.status === "running")
                throw new Error("Development work is paused with its workspace.");
              // Admission recovery may only release an interrupted, never-started
              // reservation. It must never turn a queued claim into new paid work.
              const result = await runDevelopmentStep(jobId, String(row.owner));
              // Exactly one saved phase fits the drain budget. A started or
              // uncertain phase is never replayed; terminal rows only settle.
              if (result.settlementPending) throw new Error("Development billing reconciliation is still pending.");
              return;
            }
          }
          if (intent.kind === "text" && tables.has("workbench_atomik_jobs")) {
            const row = (
              await db().execute({
                sql: "SELECT owner FROM workbench_atomik_jobs WHERE id=?",
                args: [jobId],
              })
            ).rows[0];
            if (row) {
              await runAtomikJob(jobId, String(row.owner));
              return;
            }
          }
          // Synchronous text without a recorded response must never be purchased twice.
          throw new Error(
            "This intent needs outcome reconciliation; automatic resubmission is forbidden.",
          );
        });
      });
    } catch {
      failed++;
    }
  }
  return {
    attempted,
    failed,
    deferred,
    remaining: (await recoveryFence().status()).intents.length,
  };
}
