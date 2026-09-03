import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncActive } from "@/lib/jobs";
import { modelLabel } from "@/lib/models";
import { prettyModel, hasFreeTier, gatewayCredits } from "@/lib/enhance";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { elevenConfigured, subscription, FALLBACK_USD_PER_CREDIT } from "@/lib/elevenlabs";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

/** The full ledger — eight aggregates over the table. Only the Usage page
 *  asks for this; the always-on chrome polls /api/usage/summary instead. */
export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  try { await syncActive(); } catch { /* report on what we have */ }

  const label = (m: string) => modelLabel(m);

  /* Prompt writing bills to whichever door wrote it: the gateway (Claude,
     on the same credit as Google's stills) or ByteDance's own writer. */
  const LEDGER = `CASE WHEN refine_model LIKE 'anthropic/%' OR refine_model LIKE 'google/%' THEN 'google' ELSE 'byteplus' END`;

  const [totals, topups, byModel, byProject, byPerson, byMonth, recent, refines,
         byVendor, promptByLedger, topupsByVendor, topupList] = await Promise.all([
    db().execute(`
      SELECT COUNT(*) AS n,
             SUM(status='succeeded') AS ok,
             SUM(status='failed')    AS failed,
             SUM(status NOT IN ('succeeded','failed','cancelled')) AS pending,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend,
             SUM(refine_model IS NOT NULL) AS prompts,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations`),
    db().execute(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM topups`),
    /* Render cost only ever exists on a delivered render, so these no longer
       filter on status: the sums are unchanged for renders, and a prompt that
       was written for a render that then failed is still money spent. */
    db().execute(`
      SELECT model, provider, SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations
      GROUP BY model, provider HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT COALESCE(p.name,'Unfiled') AS name, SUM(g.status='succeeded') AS n,
             COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0) AS spend
      FROM generations g LEFT JOIN projects p ON p.id = g.project_id
      GROUP BY g.project_id HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT COALESCE(u.name,'Unknown') AS name, SUM(g.status='succeeded') AS n,
             COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0) AS spend
      FROM generations g LEFT JOIN users u ON u.id = g.created_by
      GROUP BY g.created_by HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT strftime('%Y-%m', datetime(created_at/1000,'unixepoch')) AS month,
             SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
      FROM generations
      GROUP BY month HAVING spend > 0 OR n > 0 ORDER BY month DESC LIMIT 12`),
    db().execute(`
      SELECT id, model, provider, kind, title, prompt, cost_usd, refine_cost_usd, refine_model,
             refine_in_tokens, refine_out_tokens, total_tokens, params, created_at
      FROM generations WHERE status='succeeded' AND cost_usd IS NOT NULL
      ORDER BY created_at DESC LIMIT 60`),
    db().execute(`
      SELECT refine_model AS model, COUNT(*) AS n,
             COALESCE(SUM(COALESCE(refine_in_tokens,0)),0)  AS in_tokens,
             COALESCE(SUM(COALESCE(refine_out_tokens,0)),0) AS out_tokens,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS spend
      FROM generations WHERE refine_model IS NOT NULL
      GROUP BY refine_model ORDER BY spend DESC, in_tokens DESC`),
    db().execute(`
      SELECT provider, COUNT(*) AS n_all, SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)),0) AS render_spend,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations WHERE deleted = 0 OR deleted IS NULL GROUP BY provider`),
    db().execute(`
      SELECT ${LEDGER} AS ledger, COUNT(*) AS prompts,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend
      FROM generations WHERE refine_model IS NOT NULL GROUP BY ledger`),
    db().execute(`SELECT provider, COALESCE(SUM(amount_usd),0) AS total, COALESCE(SUM(credits),0) AS credits FROM topups GROUP BY provider`),
    db().execute(`SELECT id, provider, amount_usd, credits, note, created_at FROM topups ORDER BY created_at DESC LIMIT 100`),
  ]);

  /* What each vendor says for itself, where it says anything. */
  const [gateway, eleven] = await Promise.all([
    gatewayCredits().catch(() => null),
    elevenConfigured() ? subscription().catch(() => null) : Promise.resolve(null),
  ]);
  const renderBy = new Map(byVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), r]));
  const promptBy = new Map(promptByLedger.rows.map((r: any) => [String(r.ledger), r]));
  const addedBy = new Map(topupsByVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.total)]));
  const creditsBy = new Map(topupsByVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.credits ?? 0)]));
  const vendors = PROVIDERS.map((p) => {
    const r: any = renderBy.get(p.id) ?? {};
    const pr: any = promptBy.get(p.id) ?? {};
    const renderSpend = Number(r.render_spend ?? 0);
    const promptSpend = Number(pr.prompt_spend ?? 0);
    const added = addedBy.get(p.id) ?? 0;
    const spent = renderSpend + promptSpend;
    // ElevenLabs is bought and spent in credits; every audio render wrote
    // its credits into total_tokens, so the ledger counts those exactly.
    const unit = p.id === "elevenlabs" ? "credits" : "usd";
    const addedCredits = creditsBy.get(p.id) ?? 0;
    const spentCredits = Number(r.tokens ?? 0);
    const usdPerCredit = p.id === "elevenlabs" ? (eleven?.usdPerCredit ?? FALLBACK_USD_PER_CREDIT) : null;
    return {
      unit, addedCredits, spentCredits, remainingCredits: addedCredits - spentCredits, usdPerCredit,
      id: p.id,
      label: p.id === "google" ? "Google Gemini" : p.label,
      via: providerVia(p),
      configured: providerConfigured(p),
      envKey: p.envKey,
      added, spent, renderSpend, promptSpend, remaining: added - spent,
      renders: Number(r.n ?? 0), attempts: Number(r.n_all ?? 0), prompts: Number(pr.prompts ?? 0),
      tokens: Number(r.tokens ?? 0),
      live: p.id === "google" && gateway
        ? { kind: "gateway" as const, balanceUsd: gateway.balanceUsd, usedUsd: gateway.usedUsd }
        : p.id === "elevenlabs" && eleven
          ? { kind: "credits" as const, used: eleven.used, limit: eleven.limit, tier: eleven.tier, resetAt: eleven.resetAt }
          : null,
      note: p.id === "google"
        ? "Stills through Vercel AI Gateway; the Claude prompt writer bills to the same credit."
        : p.id === "byteplus" ? "Seedance video and ByteDance's own prompt writer."
        : p.id === "fal" ? "Identity training and identity stills. fal publishes no balance over the API."
        : "Voice, sound effects and music. Billed in the plan's credits; the plan's own counter is the authority.",
      models: byModel.rows.filter((m: any) => String(m.provider ?? "byteplus") === p.id).map((m: any) => ({
        model: m.model, label: label(m.model), n: Number(m.n), spend: Number(m.spend), tokens: Number(m.tokens),
      })),
      topups: topupList.rows.filter((t: any) => String(t.provider ?? "byteplus") === p.id).map((t: any) => ({
        id: t.id, amountUsd: Number(t.amount_usd), credits: t.credits == null ? null : Number(t.credits),
        note: t.note ?? "", createdAt: Number(t.created_at),
      })),
    };
  });

  const t: any = totals.rows[0];
  const spend = Number(t.spend);
  const purchased = Number((topups.rows[0] as any).total);
  const okCount = Number(t.ok);

  return NextResponse.json({
    purchasedUsd: purchased,
    spentUsd: spend,
    remainingUsd: purchased - spend,
    /* One ledger per vendor: what was added, what it has cost, what's left. */
    vendors,
    totalGenerations: Number(t.n),
    succeeded: okCount,
    failed: Number(t.failed),
    pending: Number(t.pending),
    totalTokens: Number(t.tokens),
    avgCostUsd: okCount ? spend / okCount : 0,
    /* The writer's share of everything, and how many prompts it wrote. */
    promptSpendUsd: Number(t.prompt_spend ?? 0),
    promptCount: Number(t.prompts ?? 0),
    byModel: byModel.rows.map((r: any) => ({
      model: r.model, label: label(r.model),
      n: Number(r.n), spend: Number(r.spend), promptSpend: Number(r.prompt_spend ?? 0),
      tokens: Number(r.tokens),
    })),
    byProject: byProject.rows.map((r: any) => ({
      name: r.name, n: Number(r.n), spend: Number(r.spend),
    })),
    byPerson: byPerson.rows.map((r: any) => ({
      name: r.name, n: Number(r.n), spend: Number(r.spend),
    })),
    byMonth: byMonth.rows.map((r: any) => ({
      month: r.month, n: Number(r.n), spend: Number(r.spend),
    })),
    recent: recent.rows.map((r: any) => ({
      id: r.id, model: r.model, label: label(r.model),
      provider: r.provider ?? "byteplus", kind: r.kind ?? "video", title: r.title ?? null,
      prompt: r.prompt,
      costUsd: Number(r.cost_usd) + Number(r.refine_cost_usd ?? 0),
      renderCostUsd: Number(r.cost_usd),
      refineCostUsd: r.refine_cost_usd == null ? null : Number(r.refine_cost_usd),
      refineModel: r.refine_model ?? null,
      refineLabel: r.refine_model ? prettyModel(r.refine_model) : null,
      refineInTokens: r.refine_in_tokens == null ? null : Number(r.refine_in_tokens),
      refineOutTokens: r.refine_out_tokens == null ? null : Number(r.refine_out_tokens),
      totalTokens: Number(r.total_tokens),
      params: JSON.parse(r.params || "{}"),
      createdAt: Number(r.created_at),
    })),
    refines: refines.rows.map((r: any) => ({
      model: r.model, label: prettyModel(r.model), n: Number(r.n),
      inTokens: Number(r.in_tokens), outTokens: Number(r.out_tokens),
      tokens: Number(r.in_tokens) + Number(r.out_tokens),
      spend: Number(r.spend),
      free: hasFreeTier(r.model),
      freeLeft: hasFreeTier(r.model) ? Math.max(0, 500000 - Number(r.in_tokens) - Number(r.out_tokens)) : 0,
    })),
  });
}
