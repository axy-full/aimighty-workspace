import { NextResponse, after as afterResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncPending } from "@/lib/jobs";
import { syncTrainingIdentities } from "@/lib/identities";
import { backfillSizes } from "@/lib/storageCost";
import { setSetting } from "@/lib/settings";
import { getWorkspace, platformDb, platformReady } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";
import { releaseHeldJobs } from "@/lib/held";
import { retryWorkspacePurges } from "@/lib/purge";
import { reconcileWorkspaces } from "@/lib/reconciliation";
import { cleanupExpiredUploads } from "@/lib/uploadReservations";
import { cleanupDeletedGenerations } from "@/lib/mediaDeletion";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Durable, leased heartbeat. The 140s admission budget leaves room for a
 * final in-flight provider download before Vercel's 300s execution ceiling. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorized = secret
    ? req.headers.get("authorization") === `Bearer ${secret}`
    : process.env.NODE_ENV !== "production";
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const startedAt = Date.now();
  const by = /vercel-cron/i.test(req.headers.get("user-agent") ?? "") ? "vercel" : "manual";
  try {
    await platformReady();
    const result = await reconcileWorkspaces({
      client: platformDb(),
      visit: async (workspaceId, deadlineAt) => {
        const workspace = await getWorkspace(workspaceId);
        if (!workspace || workspace.deletedAt) return { failed: false, completed: 0 };
        return runInTenant(workspace, async () => {
          await ready();
          let failed = false;
          let deferred = false;
          const stage = async (name: string, work: () => Promise<unknown>) => {
            if (Date.now() >= deadlineAt) { deferred = true; return; }
            try { await work(); }
            catch {
              failed = true;
              // Fixed stage names only: provider exceptions can contain URLs,
              // signed query strings, prompts or credentials.
              console.error(JSON.stringify({ level: "error", event: "reconciliation.stage_failed", stage: name }));
            }
          };
          const before = await counts();
          await stage("generations", async () => {
            const report = await syncPending(8, { deadlineAt });
            if (report.failed) throw new Error("RECONCILIATION_FAILED");
            deferred ||= report.deferred > 0;
          });
          await stage("training", async () => {
            const report = await syncTrainingIdentities(2);
            if (report.failed) throw new Error("TRAINING_RECONCILIATION_FAILED");
          });
          await stage("storage_sizes", () => backfillSizes(8));
          await stage("expired_uploads", async () => {
            const report = await cleanupExpiredUploads(5);
            if ("failed" in report && report.failed) throw new Error("UPLOAD_CLEANUP_FAILED");
          });
          await stage("deleted_media", async () => {
            if ((await cleanupDeletedGenerations(5)).failed) throw new Error("MEDIA_CLEANUP_FAILED");
          });
          await stage("held_jobs", () => releaseHeldJobs({ defer: (fn) => afterResponse(fn) }));
          const after = await counts();
          const completed = Math.max(0, before.pending - after.pending);
          // Record attempts separately; only fully successful visits advance
          // lastCronAt, which existing workspace health clients consume.
          await setSetting("lastCronAttemptAt", String(Date.now()), "cron");
          await setSetting("lastCronBy", by, "cron");
          await setSetting("lastCronStatus", failed ? "failed" : deferred ? "partial" : "succeeded", "cron");
          await setSetting("lastCronResult", JSON.stringify({
            ok: !failed, deferred, pending: after.pending, atRisk: after.atRisk,
            rescued: Math.max(0, before.atRisk - after.atRisk), completed,
          }), "cron");
          if (!failed && !deferred) await setSetting("lastCronAt", String(Date.now()), "cron");
          return { failed, completed, deferred };
        });
      },
      cleanup: () => retryWorkspacePurges(1),
    });
    console[result.ok ? "info" : "error"](JSON.stringify({
      level: result.ok ? "info" : "error", event: "reconciliation.finished",
      durationMs: Date.now() - startedAt, ...result,
    }));
    return NextResponse.json(result, {
      status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" },
    });
  } catch {
    console.error(JSON.stringify({ level: "error", event: "reconciliation.unavailable", durationMs: Date.now() - startedAt }));
    return NextResponse.json({ ok: false, error: "Reconciliation unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}

async function counts() {
  const rs = await db().execute(`
    SELECT SUM(CASE WHEN status NOT IN ('succeeded','failed','cancelled') AND deleted=0 THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='succeeded' AND stored_url IS NULL AND deleted=0 THEN 1 ELSE 0 END) AS atrisk
    FROM generations`);
  const row = rs.rows[0];
  return { pending: Number(row?.pending ?? 0), atRisk: Number(row?.atrisk ?? 0) };
}
