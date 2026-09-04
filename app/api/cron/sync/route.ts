import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncPending } from "@/lib/jobs";
import { syncTrainingIdentities } from "@/lib/identities";
import { backfillSizes } from "@/lib/storageCost";
import { setSetting } from "@/lib/settings";

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
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ready();
  const before = await counts();
  try {
    await syncPending(30);
    // Faces mid-training get asked about too, so a finished model is found
    // even if nobody opens the Studio for a while.
    await syncTrainingIdentities(10).catch(() => {});
    // Renders made before anyone recorded a size. Costs five millionths of a
    // dollar per thousand blobs and stops the moment there is nothing left.
    await backfillSizes().catch(() => {});
  } catch (e) {
    console.error("cron sync failed:", (e as Error).message);
  }
  const after = await counts();

  // Leave a mark. Nothing anywhere recorded when this last ran, which is how
  // "is the cron firing?" became a question nobody could answer from the
  // outside. Vercel stamps its scheduled calls with x-vercel-cron: 1, so the
  // record also says WHO ran it — a manual curl and a real tick look
  // identical otherwise.
  // Vercel's documented signature for a scheduled call is the user-agent
  // "vercel-cron/1.0"; the x-vercel-cron header was a guess and misfiled a
  // real tick as "manual". Check both, and keep the raw agent so the record
  // can never be wrong silently again.
  const ua = req.headers.get("user-agent") ?? "";
  const by = req.headers.get("x-vercel-cron") || /vercel-cron/i.test(ua) ? "vercel" : "manual";
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

  return NextResponse.json({
    ok: true,
    pending: after.pending,
    videosAtRisk: after.atRisk,
    rescuedThisRun: Math.max(0, before.atRisk - after.atRisk),
    completedThisRun: Math.max(0, before.pending - after.pending),
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
