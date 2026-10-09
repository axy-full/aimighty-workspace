import {
  recoveryFence,
  recoveryRoute,
  reserveRecoveryContinuation,
} from "@/lib/recovery";
import {
  drainRecoveryJobs,
  RECOVERY_DRAIN_WORK_BUDGET_MS,
} from "@/lib/recoveryDrain";
import { NextResponse, after as afterResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncPending } from "@/lib/jobs";
import { syncTrainingIdentities } from "@/lib/identities";
import { syncSoulIdentities } from "@/lib/soulIdentities";
import { backfillSizes } from "@/lib/storageCost";
import { setSetting } from "@/lib/settings";
import { getWorkspace, platformDb, platformReady } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";
import { releaseHeldJobs } from "@/lib/held";
import { retireDeletedWorkspaces } from "@/lib/purge";
import { reconcileWorkspaces } from "@/lib/reconciliation";
import { cleanupExpiredUploads } from "@/lib/uploadReservations";
import { drainPipelineWakeups } from "@/lib/pipeline/executor";
import { sweepConsumerJobs } from "@/lib/higgsfield-consumer/sweep";
import { SIGN_IN_OFF } from "@/lib/higgsfield-consumer/retired";
import { drainCanvasPushes } from "@/lib/workbench/canvas-push";
import { drainRigAgentWakeups } from "@/lib/workbench/rig-agent";
import { expireUnansweredCinemaTakes } from "@/lib/genjutsuVideo";
import { reconcilePaidTextJobs } from "@/lib/paidText";
import { alertRendersAtRisk, recordRendersAtRisk } from "@/lib/rendersAtRisk";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Durable, leased heartbeat. The 140s admission budget leaves room for a
 * final in-flight provider download before Vercel's 300s execution ceiling. */
export async function GET(req: Request) {
  const requestStartedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  const authorized = secret
    ? req.headers.get("authorization") === `Bearer ${secret}`
    : process.env.NODE_ENV !== "production";
  if (!authorized)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const fence = await recoveryFence().status();
  if (fence.state === "draining")
    return NextResponse.json(
      await drainRecoveryJobs(8, {
        deadlineAt: requestStartedAt + RECOVERY_DRAIN_WORK_BUDGET_MS,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  if (fence.state === "closed")
    return NextResponse.json(
      { maintenance: true },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  return recoveryRoute(async () => {
    const startedAt = Date.now();
    const by = /vercel-cron/i.test(req.headers.get("user-agent") ?? "")
      ? "vercel"
      : "manual";
    try {
      await platformReady();
      const result = await reconcileWorkspaces({
        client: platformDb(),
        visit: async (workspaceId, deadlineAt) => {
          const workspace = await getWorkspace(workspaceId);
          if (!workspace || workspace.deletedAt)
            return { failed: false, completed: 0 };
          return runInTenant(workspace, async () => {
            await ready();
            let failed = false;
            let deferred = false;
            const stage = async (
              name: string,
              work: () => Promise<unknown>,
            ) => {
              if (Date.now() >= deadlineAt) {
                deferred = true;
                return;
              }
              try {
                await work();
              } catch {
                failed = true;
                // Fixed stage names only: provider exceptions can contain URLs,
                // signed query strings, prompts or credentials.
                console.error(
                  JSON.stringify({
                    level: "error",
                    event: "reconciliation.stage_failed",
                    stage: name,
                  }),
                );
              }
            };
            const before = await counts();
            await stage("generations", async () => {
              const report = await syncPending(8, { deadlineAt });
              if (report.failed) throw new Error("RECONCILIATION_FAILED");
              deferred ||= report.deferred > 0;
            });
            await stage("pipelines", async () => {
              const report = await drainPipelineWakeups({
                limit: 2,
                deadlineAt,
                defer: async (fn) => {
                  afterResponse(
                    await reserveRecoveryContinuation("pipeline-render", fn),
                  );
                },
              });
              if (report.failed) throw new Error("PIPELINE_RECOVERY_FAILED");
            });
            await stage("training", async () => {
              const report = await syncTrainingIdentities(2);
              if (report.failed)
                throw new Error("TRAINING_RECONCILIATION_FAILED");
            });
            await stage("soul_training", async () => {
              const report = await syncSoulIdentities(2, { deadlineAt });
              if (report.failed) throw new Error("SOUL_RECONCILIATION_FAILED");
            });
            // Connected-account jobs finished with no page open. Off for
            // Release 1 with the Higgsfield sign-in (SIGN_IN_OFF in
            // lib/higgsfield-consumer/retired.ts): no stored grant is read.
            if (!SIGN_IN_OFF)
              await stage("connected_jobs", async () => {
                const report = await sweepConsumerJobs({ limit: 2, deadlineAt });
                deferred ||= report.deferred;
              });
            // Server-made Rig canvas changes the live room has not taken yet
            // (free; the room only ever gets what the saved canvas holds).
            await stage("canvas_pushes", () =>
              drainCanvasPushes(null, { limit: 4, deadlineAt }),
            );
            // Atomik runs on Rig boards whose wake is due: a plan, a build or
            // a render a lost event left waiting, or one paused by the kill
            // switch. A render spends only inside the limit a person approved
            // for its run, under its saved request key (never re-sent); what
            // a stopped run left mid-way is closed with free reads.
            await stage("rig_agents", () =>
              drainRigAgentWakeups({ limit: 2, deadlineAt }),
            );
            await stage("storage_sizes", () => backfillSizes(8));
            await stage("expired_uploads", async () => {
              const report = await cleanupExpiredUploads(5);
              if ("failed" in report && report.failed)
                throw new Error("UPLOAD_CLEANUP_FAILED");
            });
            // A Cinema Studio take with no answer from its provider after 24 hours: failed, charged nothing, its hold
            // released and the admin desk told (lib/genjutsuVideo.ts). Before held_jobs, so the credits it frees
            // can start what waits for them. Free: nothing is sent to any provider.
            await stage("cinema_unanswered", () =>
              expireUnansweredCinemaTakes({ limit: 5, deadlineAt }),
            );
            // A text job (Enhance, Atomik) no request will finish: cut off, killed
            // mid-call or before it was sent, 30 min on. Refunded once (lib/paidText.ts);
            // before held_jobs, so the credits it returns can start what waits. Counts only.
            await stage("paid_text", async () => {
              const report = await reconcilePaidTextJobs({ limit: 10, deadlineAt });
              if (report.refunded || report.released || report.failed)
                console.info(JSON.stringify({ level: "info", event: "reconciliation.paid_text", ...report }));
              if (report.failed) throw new Error("PAID_TEXT_RECONCILIATION_FAILED");
            });
            await stage("held_jobs", () =>
              releaseHeldJobs({ defer: (fn) => afterResponse(fn) }),
            );
            // Renders at risk (no stored copy an hour on), recorded for the
            // platform owner's alert, sent after the visits (lib/rendersAtRisk.ts).
            // Not a stage: it never fails or defers the visit, and logs its own failures.
            if (Date.now() < deadlineAt) await recordRendersAtRisk();
            const after = await counts();
            const completed = Math.max(0, before.pending - after.pending);
            // Record attempts separately; only fully successful visits advance
            // lastCronAt, which existing workspace health clients consume.
            await setSetting("lastCronAttemptAt", String(Date.now()), "cron");
            await setSetting("lastCronBy", by, "cron");
            await setSetting(
              "lastCronStatus",
              failed ? "failed" : deferred ? "partial" : "succeeded",
              "cron",
            );
            await setSetting(
              "lastCronResult",
              JSON.stringify({
                ok: !failed,
                deferred,
                pending: after.pending,
                atRisk: after.atRisk,
                rescued: Math.max(0, before.atRisk - after.atRisk),
                completed,
              }),
              "cron",
            );
            if (!failed && !deferred)
              await setSetting("lastCronAt", String(Date.now()), "cron");
            return { failed, completed, deferred };
          });
        },
        // Still under the reconciliation lease: one process emails, and the
        // marks it leaves are in the platform database. Never throws.
        cleanup: async () => {
          try {
            return await retireDeletedWorkspaces(1);
          } finally {
            await alertRendersAtRisk();
          }
        },
      });
      console[result.ok ? "info" : "error"](
        JSON.stringify({
          level: result.ok ? "info" : "error",
          event: "reconciliation.finished",
          durationMs: Date.now() - startedAt,
          ...result,
        }),
      );
      return NextResponse.json(result, {
        status: result.ok ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "reconciliation.unavailable",
          durationMs: Date.now() - startedAt,
        }),
      );
      return NextResponse.json(
        { ok: false, error: "Reconciliation unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  })();
}

async function counts() {
  const rs = await db().execute(`
    SELECT SUM(CASE WHEN status NOT IN ('succeeded','failed','cancelled') AND deleted=0 THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='succeeded' AND stored_url IS NULL AND deleted=0 THEN 1 ELSE 0 END) AS atrisk
    FROM generations`);
  const row = rs.rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    atRisk: Number(row?.atrisk ?? 0),
  };
}
