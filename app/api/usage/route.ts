import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncActive } from "@/lib/jobs";
import { modelLabel } from "@/lib/models";
import { prettyModel, hasFreeTier } from "@/lib/enhance";
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

  const [totals, topups, byModel, byProject, byPerson, byMonth, recent, refines] = await Promise.all([
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
      SELECT model, SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations
      GROUP BY model HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
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
      SELECT id, model, prompt, cost_usd, refine_cost_usd, refine_model,
             refine_in_tokens, refine_out_tokens, total_tokens, params, created_at
      FROM generations WHERE status='succeeded' AND cost_usd IS NOT NULL
      ORDER BY created_at DESC LIMIT 40`),
    db().execute(`
      SELECT refine_model AS model, COUNT(*) AS n,
             COALESCE(SUM(COALESCE(refine_in_tokens,0)),0)  AS in_tokens,
             COALESCE(SUM(COALESCE(refine_out_tokens,0)),0) AS out_tokens,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS spend
      FROM generations WHERE refine_model IS NOT NULL
      GROUP BY refine_model ORDER BY spend DESC, in_tokens DESC`),
  ]);

  const t: any = totals.rows[0];
  const spend = Number(t.spend);
  const purchased = Number((topups.rows[0] as any).total);
  const okCount = Number(t.ok);

  return NextResponse.json({
    purchasedUsd: purchased,
    spentUsd: spend,
    remainingUsd: purchased - spend,
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
