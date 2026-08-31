import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The cheap cousin of /api/usage.
 *
 * The app's permanent chrome — the title bar's "Rendering" pill and the
 * rail's SPENT/CREDIT line — used to poll the full Usage endpoint, which runs
 * eight aggregates over the whole generations table. Every 20–30 seconds. On
 * every page. For every person. That cost grows linearly with the library, so
 * a workspace with a few thousand renders spends its database quota on chrome
 * nobody is reading.
 *
 * This answers only what the chrome shows, in two queries, memoised briefly
 * so several open tabs collapse into one read.
 */

type Summary = { pending: number; spentUsd: number; purchasedUsd: number; remainingUsd: number };

let cache: { at: number; value: Summary } | null = null;
const TTL_MS = 20_000;

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  if (cache && now() - cache.at < TTL_MS) {
    return NextResponse.json({ ...cache.value, cached: true });
  }

  const [gen, top] = await Promise.all([
    db().execute(`
      SELECT COALESCE(SUM(status IN ('queued','running')), 0) AS pending,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)), 0) AS spend
      FROM generations WHERE deleted = 0`),
    db().execute(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM topups`),
  ]);

  const g: any = gen.rows[0];
  const spentUsd = Number(g?.spend ?? 0);
  const purchasedUsd = Number((top.rows[0] as any)?.total ?? 0);
  const value: Summary = {
    pending: Number(g?.pending ?? 0),
    spentUsd,
    purchasedUsd,
    remainingUsd: purchasedUsd - spentUsd,
  };

  cache = { at: now(), value };
  return NextResponse.json(value);
}
