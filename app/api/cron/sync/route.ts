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
import { atRiskCounts, atRiskHorizon, listAtRisk, logUnsavable, storedAmong, whyNotSaved } from "@/lib/atRisk";
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
    /* Our own server's scheduled task (ops/selfhost/cron-sync.mjs) names itself in its user-agent; anything else holding the secret is manual. Recorded, never trusted: the bearer secret is what lets a caller in. */
    const by = req.headers.get("user-agent")?.trim() === "particl-scheduler/1" ? "scheduler" : "manual";
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
            /* One window for the whole visit (lib/atRisk.ts), so a take that ages out between the two counts is not counted as rescued. */
            const horizon = atRiskHorizon();
            const before = await counts(horizon);
            const unsavedBefore = await listAtRisk(horizon, AT_RISK_LISTED).catch(() => []);
            let atRiskTried = 0;
            await stage("generations", async () => {
              const report = await syncPending(8, { deadlineAt, horizon, onAtRiskChosen: (count) => { atRiskTried = count; } });
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
            const after = await counts(horizon);
            /* The takes the heartbeat has no way to save get one line each a day, with a reason (lib/atRisk.ts); the others it tries again next visit. Reads only. */
            const unsavedAfter = await listAtRisk(horizon, AT_RISK_LISTED).catch(() => []);
            const unsavable = unsavedAfter.flatMap((row) => { const reason = whyNotSaved(row); return reason ? [{ ...row, reason }] : []; });
            await logUnsavable(unsavable).catch(() => 0);
            const stored = await storedAmong(unsavedBefore.map((row) => row.id)).catch(() => new Set<string>());
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
                /* Takes unsaved for more than 72 hours: nothing tries any more (lib/atRisk.ts). */
                lost: after.lost,
                /* A net figure, as before: what was at risk at the start minus what is now. */
                rescued: Math.max(0, before.atRisk - after.atRisk),
                /* The at-risk takes the visit chose to save, those it did save (by take), and those it has no way to save, each with a logged reason. */
                tried: atRiskTried,
                saved: stored.size,
                unsavable: unsavable.length,
                completed,
              }),
              "cron",
            );
            if (!failed && !deferred)
              await setSetting("lastCronAt", String(Date.now()), "cron");
            return { failed, completed, deferred };
          });
        },
        cleanup: () => retireDeletedWorkspaces(1),
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

/** The most at-risk takes read per visit for the reasons and the saved count; a workspace with more is counted in full, and these are its newest. */
const AT_RISK_LISTED = 200;

async function counts(horizon: number) {
  const rs = await db().execute(`
    SELECT SUM(CASE WHEN status NOT IN ('succeeded','failed','cancelled') AND deleted=0 THEN 1 ELSE 0 END) AS pending
    FROM generations`);
  const row = rs.rows[0];
  /* At risk and lost are lib/atRisk.ts's definition, the same one the health counter and the console use. All kinds of take, not only videos. */
  const risk = await atRiskCounts(horizon);
  return {
    pending: Number(row?.pending ?? 0),
    atRisk: risk.atRisk,
    lost: risk.lost,
  };
}
