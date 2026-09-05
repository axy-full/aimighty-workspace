import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncPending } from "@/lib/jobs";
import { syncTrainingIdentities } from "@/lib/identities";
import { backfillSizes } from "@/lib/storageCost";
import { setSetting } from "@/lib/settings";
import { listWorkspaces } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Server-side heartbeat, run by Vercel Cron every 10 minutes.
 *
 * Renders were previously pulled into our storage only while someone's
 * browser was polling — a clip finishing after everyone closed their laptop
 * raced ByteDance's ~24h URL expiry. This makes persistence unconditional:
 * the render is copied into our own storage within minutes of completing,
 * open tab or not.
 *
 * When CRON_SECRET is set, Vercel sends it as a bearer token and we require
 * it. Without the secret the route still runs but reveals only counts — the
 * same class of information as /api/health.
 */
export async function GET(req: Request) {
  /* Fail CLOSED in production.
   *
   * This used to read `if (secret && ...)`, which is a guard that disarms
   * itself: with CRON_SECRET unset — which is how the deployment actually
   * ran — the condition was never true and the route answered anybody. It
   * reports live render counts and starts reconciliation work, so once the
   * app went public that was a stranger's button.
   *
   * Locally the secret is not expected and the route stays open, which is
   * what makes it testable without one. */
  const secret = process.env.CRON_SECRET;
  const authorised = secret
    ? req.headers.get("authorization") === `Bearer ${secret}`
    : process.env.NODE_ENV !== "production";
  if (!authorised) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ua = req.headers.get("user-agent") ?? "";
  const by = req.headers.get("x-vercel-cron") || /vercel-cron/i.test(ua) ? "vercel" : "manual";
  const totals = { pending: 0, atRisk: 0, rescued: 0, completed: 0, workspaces: 0 };

  /* Every workspace has its own database, so the heartbeat visits each in
     turn: pending renders pulled into storage, faces mid-training asked
     about, sizes backfilled — and a mark left so "is the cron firing?" is
     answerable from inside any of them. */
  for (const ws of await listWorkspaces()) {
    await runInTenant(ws, async () => {
      try {
        await ready();
        const before = await counts();
        try {
          await syncPending(30);
          await syncTrainingIdentities(10).catch(() => {});
          await backfillSizes().catch(() => {});
        } catch (e) {
          console.error(`cron sync failed for ${ws.slug}:`, (e as Error).message);
        }
        const after = await counts();
        totals.workspaces++;
        totals.pending += after.pending; totals.atRisk += after.atRisk;
        totals.rescued += Math.max(0, before.atRisk - after.atRisk);
        totals.completed += Math.max(0, before.pending - after.pending);
        try {
          await setSetting("lastCronAt", String(Date.now()), "cron");
          await setSetting("lastCronBy", by, "cron");
          await setSetting("lastCronAgent", ua.slice(0, 120), "cron");
          await setSetting("lastCronResult", JSON.stringify({
            pending: after.pending, atRisk: after.atRisk,
            rescued: Math.max(0, before.atRisk - after.atRisk),
            completed: Math.max(0, before.pending - after.pending),
          }), "cron");
        } catch (e) {
          console.error("cron: could not record the run:", (e as Error).message);
        }
      } catch (e) {
        console.error(`cron: workspace ${ws.slug} unreachable:`, (e as Error).message);
      }
    });
  }

  return NextResponse.json({
    ok: true,
    workspaces: totals.workspaces,
    pending: totals.pending,
    videosAtRisk: totals.atRisk,
    rescuedThisRun: totals.rescued,
    completedThisRun: totals.completed,
  });
}

async function counts() {
  const rs = await db().execute(`
    SELECT SUM(CASE WHEN status NOT IN ('succeeded','failed','cancelled') AND deleted=0 THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='succeeded' AND stored_url IS NULL AND deleted=0 THEN 1 ELSE 0 END) AS atrisk
    FROM generations`);
  const r: any = rs.rows[0];
  return { pending: Number(r?.pending ?? 0), atRisk: Number(r?.atrisk ?? 0) };
}
