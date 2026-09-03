import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { PROVIDERS } from "@/lib/providers";

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

type Summary = {
  pending: number; spentUsd: number; purchasedUsd: number; remainingUsd: number;
  /** The writer's share of spentUsd. */
  promptSpendUsd: number;
  /** Each vendor's own credit position. */
  vendors: { id: string; label: string; spent: number; added: number; remaining: number; unit: "usd" | "credits"; remainingCredits?: number; addedCredits?: number; spentCredits?: number }[];
};

let cache: { at: number; value: Summary } | null = null;
const TTL_MS = 20_000;

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  if (cache && now() - cache.at < TTL_MS) {
    return NextResponse.json({ ...cache.value, cached: true });
  }

  const [gen, top, byVendor, promptBy] = await Promise.all([
    db().execute(`
      SELECT COALESCE(SUM(status IN ('queued','running')), 0) AS pending,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)), 0) AS spend,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)), 0) AS prompt_spend
      FROM generations WHERE deleted = 0`),
    db().execute(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM topups`),
    db().execute(`SELECT provider, COALESCE(SUM(COALESCE(cost_usd,0)),0) AS spend FROM generations GROUP BY provider`),
    db().execute(`
      SELECT CASE WHEN refine_model LIKE 'anthropic/%' OR refine_model LIKE 'google/%' THEN 'google' ELSE 'byteplus' END AS ledger,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS spend
      FROM generations WHERE refine_model IS NOT NULL GROUP BY ledger`),
  ]);
  const added = await db().execute(`SELECT provider, COALESCE(SUM(amount_usd),0) AS total, COALESCE(SUM(credits),0) AS credits FROM topups GROUP BY provider`);
  const audio = await db().execute(`SELECT COALESCE(SUM(total_tokens),0) AS credits FROM generations WHERE provider='elevenlabs' AND deleted = 0`);

  const g: any = gen.rows[0];
  const spentUsd = Number(g?.spend ?? 0);
  const purchasedUsd = Number((top.rows[0] as any)?.total ?? 0);
  const spendBy = new Map(byVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.spend)]));
  const promptSpendBy = new Map(promptBy.rows.map((r: any) => [String(r.ledger), Number(r.spend)]));
  const addedBy = new Map(added.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.total)]));
  const creditsBy = new Map(added.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.credits ?? 0)]));
  const audioCredits = Number((audio.rows[0] as any)?.credits ?? 0);
  const vendors = PROVIDERS.map((p) => {
    const spent = (spendBy.get(p.id) ?? 0) + (promptSpendBy.get(p.id) ?? 0);
    const a = addedBy.get(p.id) ?? 0;
    const unit = p.id === "elevenlabs" ? "credits" as const : "usd" as const;
    return {
      id: p.id, label: p.id === "google" ? "Google Gemini" : p.label, spent, added: a, remaining: a - spent, unit,
      ...(unit === "credits" ? { addedCredits: creditsBy.get(p.id) ?? 0, spentCredits: audioCredits, remainingCredits: (creditsBy.get(p.id) ?? 0) - audioCredits } : {}),
    };
  });
  const value: Summary = {
    pending: Number(g?.pending ?? 0),
    spentUsd,
    purchasedUsd,
    remainingUsd: purchasedUsd - spentUsd,
    promptSpendUsd: Number(g?.prompt_spend ?? 0),
    vendors,
  };

  cache = { at: now(), value };
  return NextResponse.json(value);
}
