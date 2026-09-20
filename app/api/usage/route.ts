import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { syncActive } from "@/lib/jobs";
import { modelLabel } from "@/lib/models";
import { hasFreeTier, gatewayCredits } from "@/lib/enhance";
import { prettyModel } from "@/lib/models";
import { PROVIDERS, providerConfigured, providerVia } from "@/lib/providers";
import { elevenConfigured, subscription, FALLBACK_USD_PER_CREDIT } from "@/lib/elevenlabs";
import { requireUser, withTenant } from "@/lib/auth";
import { listChecks, spendSince, computedSpendUpTo } from "@/lib/reconcile";
import { storageLedger } from "@/lib/storageCost";
import { billedCreditsSum } from "@/lib/creditSql";
import {creditUsage} from "@/lib/creditUsage";
import {creditsApply} from "@/lib/credits";
import {requireTenant} from "@/lib/tenant";
import { billCredits, marginKeyOf } from "@/lib/creditTerms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

/** The full ledger — eight aggregates over the table. Only the Usage page
 *  asks for this; the always-on chrome polls /api/usage/summary instead. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  if(creditsApply(requireTenant()))return NextResponse.json(await creditUsage(),{headers:{"Cache-Control":"no-store"}});
  await ready();
  try { await syncActive(); } catch { /* report on what we have */ }

  const label = (m: string) => modelLabel(m);

  /* WHOSE BALANCE THE THINKING CAME OUT OF.
     Every gateway model is named vendor/model — "anthropic/claude-opus-5",
     "google/gemini-3-flash" — and every one of them is paid for in Vercel
     AI Gateway credit, whoever built the model. ByteDance's own text
     models are bare ids and are paid for on the ModelArk key.

     This used to read the vendor out of the model's PREFIX and charge
     Claude's thinking to Google, which is a company that was never
     involved. Google's ledger could not agree with Google's console, and
     Vercel's spend was invisible because Vercel was not a vendor here at
     all. */
  const LEDGER = `CASE WHEN refine_model LIKE '%/%' THEN 'vercel' ELSE 'byteplus' END`;
  /* Renders are charged where the money actually left, which for stills is
     not always the vendor that made them — see billed_to in lib/db.ts.
     Older rows have no value and fall back to provider, which is exactly
     what this sum assumed before the column existed. */
  const PAID_BY = `COALESCE(billed_to, provider)`;

  const [totals, topups, byModel, byProject, byPerson, byMonth, recent, stages, refines,
         byVendor, promptByLedger, topupsByVendor, topupList, atomikText] = await Promise.all([
    db().execute(`
      SELECT COUNT(*) AS n,
             SUM(status='succeeded') AS ok,
             SUM(status='failed')    AS failed,
             SUM(status NOT IN ('succeeded','failed','cancelled')) AS pending,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend,
             ${billedCreditsSum()} AS credits,
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
             ${billedCreditsSum()} AS credits,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations
      GROUP BY model, provider HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT COALESCE(p.name,'Unfiled') AS name, SUM(g.status='succeeded') AS n,
             COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0) AS spend,
             ${billedCreditsSum("g")} AS credits
      FROM generations g LEFT JOIN projects p ON p.id = g.project_id
      GROUP BY g.project_id HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT COALESCE(u.name,'Unknown') AS name, SUM(g.status='succeeded') AS n,
             COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0) AS spend,
             ${billedCreditsSum("g")} AS credits
      FROM generations g LEFT JOIN users u ON u.id = g.created_by
      GROUP BY g.created_by HAVING spend > 0 OR n > 0 ORDER BY spend DESC`),
    db().execute(`
      SELECT strftime('%Y-%m', datetime(created_at/1000,'unixepoch')) AS month,
             SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend,
             ${billedCreditsSum()} AS credits
      FROM generations
      GROUP BY month HAVING spend > 0 OR n > 0 ORDER BY month DESC LIMIT 12`),
    db().execute(`
      SELECT id, model, provider, kind, title, prompt, cost_usd, refine_cost_usd, refine_model,
             refine_in_tokens, refine_out_tokens, total_tokens, params, created_at
      FROM generations WHERE status='succeeded' AND cost_usd IS NOT NULL
      ORDER BY created_at DESC LIMIT 60`),
    /* Where the time goes. Only rows that recorded a stage, so the medians
       describe renders made since the timing landed rather than being
       diluted by every older row that never measured anything. */
    db().execute(`
      SELECT kind, queue_ms, refine_ms, submit_ms, engine_ms, notice_ms, store_ms,
             /* The wait a PERSON experiences, which starts when they press the
                button. duration_ms alone misses the prompt writer, because the
                row's clock only starts once the writer has finished and the
                row is inserted. */
             duration_ms + COALESCE(refine_ms, 0) AS wait_ms
      FROM generations
      WHERE status='succeeded' AND deleted=0
        AND (engine_ms IS NOT NULL OR store_ms IS NOT NULL OR refine_ms IS NOT NULL)
      ORDER BY created_at DESC LIMIT 400`),
    db().execute(`
      SELECT refine_model AS model, COUNT(*) AS n,
             COALESCE(SUM(COALESCE(refine_in_tokens,0)),0)  AS in_tokens,
             COALESCE(SUM(COALESCE(refine_out_tokens,0)),0) AS out_tokens,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS spend
      FROM generations WHERE refine_model IS NOT NULL
      GROUP BY refine_model ORDER BY spend DESC, in_tokens DESC`),
    db().execute(`
      SELECT ${PAID_BY} AS provider, COUNT(*) AS n_all, SUM(status='succeeded') AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)),0) AS render_spend,
             COALESCE(SUM(total_tokens),0) AS tokens
      FROM generations WHERE deleted = 0 OR deleted IS NULL GROUP BY ${PAID_BY}`),
    db().execute(`
      SELECT ${LEDGER} AS ledger, COUNT(*) AS prompts,
             COALESCE(SUM(COALESCE(refine_cost_usd,0)),0) AS prompt_spend
      FROM generations WHERE refine_model IS NOT NULL GROUP BY ledger`),
    db().execute(`SELECT provider, COALESCE(SUM(amount_usd),0) AS total, COALESCE(SUM(credits),0) AS credits FROM topups GROUP BY provider`),
    db().execute(`SELECT id, provider, amount_usd, credits, note, created_at FROM topups ORDER BY created_at DESC LIMIT 100`),
    /* Atomik's thinking. It is the only spend in this app that is not
       attached to a render — a conversation costs money whether or not
       anything is ever approved out of it — so it has to be summed from
       its own table or it simply would not appear on any ledger. */
    db().execute(`SELECT COALESCE(SUM(COALESCE(text_cost_usd,0)),0)
                         + (SELECT COALESCE(SUM(cost_usd),0) FROM atomik_spend) AS spend,
                         COUNT(*) AS chats
                  FROM atomik_chats WHERE deleted = 0`),
  ]);
  const atomikRow = atomikText.rows[0] as Record<string, unknown> | undefined;
  const atomikUsd = Number(atomikRow?.spend ?? 0);
  const atomikChats = Number(atomikRow?.chats ?? 0);

  /* The only cost here that is rent rather than a purchase. */
  const storage = await storageLedger().catch(() => null);

  /* What each vendor says for itself, where it says anything. */
  const [gateway, eleven] = await Promise.all([
    gatewayCredits().catch(() => null),
    elevenConfigured() ? subscription().catch(() => null) : Promise.resolve(null),
  ]);
  /* The most recent reading from each vendor's own console. From that point
     the ledger reports THEIR number plus what we have computed since, so it
     agrees with the console instead of quietly diverging from it. */
  const checks = await listChecks();
  const latestCheck = new Map<string, (typeof checks)[number]>();
  for (const c of checks) if (!latestCheck.has(c.provider)) latestCheck.set(c.provider, c);
  const anchors = new Map<string, {
    check: (typeof checks)[number];
    sinceUsd: number; sinceCredits: number; sinceRenders: number;
    driftUsd: number | null; driftCredits: number | null;
  }>();
  for (const [provider, check] of latestCheck) {
    const [since, computedThen] = await Promise.all([
      spendSince(provider, check.checkedAt),
      computedSpendUpTo(provider, check.checkedAt),
    ]);
    anchors.set(provider, {
      check,
      sinceUsd: since.usd,
      sinceCredits: since.credits,
      sinceRenders: since.renders,
      // How far our arithmetic had drifted by the moment of the reading.
      // Positive means we were over-counting: the vendor charged less.
      driftUsd: check.spendUsd == null ? null : computedThen.usd - check.spendUsd,
      driftCredits: check.spendCredits == null ? null : computedThen.credits - check.spendCredits,
    });
  }
  const renderBy = new Map(byVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), r]));
  const promptBy = new Map(promptByLedger.rows.map((r: any) => [String(r.ledger), r]));
  const addedBy = new Map(topupsByVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.total)]));
  const creditsBy = new Map(topupsByVendor.rows.map((r: any) => [String(r.provider ?? "byteplus"), Number(r.credits ?? 0)]));
  const vendors = PROVIDERS.map((p) => {
    const r: any = renderBy.get(p.id) ?? {};
    const pr: any = promptBy.get(p.id) ?? {};
    const renderSpend = Number(r.render_spend ?? 0);
    /* Atomik's conversations are gateway text, so they land on the gateway's
       own line beside the prompt writer's. */
    const promptSpend = Number(pr.prompt_spend ?? 0) + (p.id === "vercel" ? atomikUsd : 0);
    const added = addedBy.get(p.id) ?? 0;
    const computedSpent = renderSpend + promptSpend;
    /* Anchored where a reading exists: the vendor's own spend, plus ours
       since. Falls back to pure computation where nobody has checked. */
    const anchor = anchors.get(p.id) ?? null;
    const spent = anchor && anchor.check.spendUsd != null
      ? anchor.check.spendUsd + anchor.sinceUsd
      : computedSpent;
    // ElevenLabs is bought and spent in credits; every audio render wrote
    // its credits into total_tokens, so the ledger counts those exactly.
    const unit = p.id === "elevenlabs" ? "credits" : "usd";
    const addedCredits = creditsBy.get(p.id) ?? 0;
    const computedCredits = Number(r.tokens ?? 0);
    const spentCredits = anchor && anchor.check.spendCredits != null
      ? anchor.check.spendCredits + anchor.sinceCredits
      : computedCredits;
    const usdPerCredit = p.id === "elevenlabs" ? (eleven?.usdPerCredit ?? FALLBACK_USD_PER_CREDIT) : null;
    return {
      unit, addedCredits, spentCredits, computedCredits, usdPerCredit,
      remainingCredits: anchor && anchor.check.balanceCredits != null
        ? anchor.check.balanceCredits - anchor.sinceCredits
        : addedCredits - spentCredits,
      id: p.id,
      label: p.label,
      serves: p.serves,
      via: providerVia(p),
      configured: providerConfigured(p),
      envKey: p.envKey,
      added, spent, renderSpend, promptSpend,
      /* A balance the console stated beats anything we can derive, so where
         one was recorded the remaining figure counts down from it.

         The gateway states its own balance over the API, which beats even a
         hand-recorded reading: it is live rather than as-of-a-moment. It is
         also the only vendor here that needs no top-ups entered by hand, so
         without this its line would read as overdrawn the moment anything
         was spent — nobody having told it about money it can see itself. */
      remaining: p.id === "vercel" && gateway
        ? gateway.balanceUsd
        : anchor && anchor.check.balanceUsd != null
          ? anchor.check.balanceUsd - anchor.sinceUsd
          : added - spent,
      computedSpent,
      anchor: anchor ? {
        checkedAt: anchor.check.checkedAt,
        balanceUsd: anchor.check.balanceUsd,
        spendUsd: anchor.check.spendUsd,
        balanceCredits: anchor.check.balanceCredits,
        spendCredits: anchor.check.spendCredits,
        note: anchor.check.note,
        authorName: anchor.check.authorName,
        sinceUsd: anchor.sinceUsd,
        sinceCredits: anchor.sinceCredits,
        sinceRenders: anchor.sinceRenders,
        driftUsd: anchor.driftUsd,
        driftCredits: anchor.driftCredits,
      } : null,
      renders: Number(r.n ?? 0), attempts: Number(r.n_all ?? 0), prompts: Number(pr.prompts ?? 0),
      tokens: Number(r.tokens ?? 0),
      /* The gateway is the one vendor here that will simply tell us what is
         left, so its line needs no top-ups recorded by hand. It reads under
         Vercel now rather than under Google: it is Vercel's balance, and
         showing it on Google's line was what made Google look funded. */
      live: p.id === "vercel" && gateway
        ? { kind: "gateway" as const, balanceUsd: gateway.balanceUsd, usedUsd: gateway.usedUsd }
        : p.id === "elevenlabs" && eleven
          ? { kind: "credits" as const, used: eleven.used, limit: eleven.limit, tier: eleven.tier, resetAt: eleven.resetAt }
          : null,
      note: p.id === "vercel"
        ? `Every text call: Atomik's ${atomikChats === 1 ? "conversation" : "conversations"} and the prompt writer. ` +
          "Stills bill here too while the gateway is the route to the image engine."
        : p.id === "google"
        ? "Stills, when they go direct on GEMINI_API_KEY. While the model gateway is the route, they bill to the gateway instead."
        : p.id === "byteplus" ? "Seedance video and its own prompt writer."
        : p.id === "fal" ? "Identity training and identity stills. This account publishes no balance over the API."
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
    spentCredits: Number(t.credits ?? 0),
    remainingUsd: purchased - spend,
    /* One ledger per vendor: what was added, what it has cost, what's left. */
    vendors,
    storage,
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
      n: Number(r.n), spend: Number(r.spend), credits: Number(r.credits ?? 0), promptSpend: Number(r.prompt_spend ?? 0),
      tokens: Number(r.tokens),
    })),
    byProject: byProject.rows.map((r: any) => ({
      name: r.name, n: Number(r.n), spend: Number(r.spend), credits: Number(r.credits ?? 0),
    })),
    byPerson: byPerson.rows.map((r: any) => ({
      name: r.name, n: Number(r.n), spend: Number(r.spend), credits: Number(r.credits ?? 0),
    })),
    byMonth: byMonth.rows.map((r: any) => ({
      month: r.month, n: Number(r.n), spend: Number(r.spend), credits: Number(r.credits ?? 0),
    })),
    recent: recent.rows.map((r: any) => ({
      id: r.id, model: r.model, label: label(r.model),
      provider: r.provider ?? "byteplus", kind: r.kind ?? "video", title: r.title ?? null,
      prompt: r.prompt,
      costUsd: Number(r.cost_usd) + Number(r.refine_cost_usd ?? 0),
      credits: billCredits(Number(r.cost_usd) + Number(r.refine_cost_usd ?? 0), marginKeyOf(r.kind ?? "video", r.model)),
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
    /* Median, not mean: a single render that waited on a dead cron would
       drag an average somewhere useless. Null where nothing recorded it. */
    timing: (() => {
      const med = (xs: number[]) => {
        if (!xs.length) return null;
        const sorted = [...xs].sort((a, b) => a - b);
        return Math.round(sorted[Math.floor(sorted.length / 2)]);
      };
      const groups: Record<string, any[]> = { video: [], image: [], audio: [] };
      for (const r of stages.rows as any[]) {
        groups[r.kind === "image" ? "image" : r.kind === "audio" ? "audio" : "video"].push(r);
      }
      const pick = (rows: any[], col: string) =>
        med(rows.map((r) => r[col]).filter((v) => v != null).map(Number));
      return Object.entries(groups)
        .filter(([, rows]) => rows.length > 0)
        .map(([kind, rows]) => ({
          kind, n: rows.length,
          totalMs: pick(rows, "wait_ms"),
          queueMs: pick(rows, "queue_ms"),
          refineMs: pick(rows, "refine_ms"),
          submitMs: pick(rows, "submit_ms"),
          engineMs: pick(rows, "engine_ms"),
          noticeMs: pick(rows, "notice_ms"),
          storeMs: pick(rows, "store_ms"),
        }));
    })(),
    refines: refines.rows.map((r: any) => ({
      model: r.model, label: prettyModel(r.model), n: Number(r.n),
      inTokens: Number(r.in_tokens), outTokens: Number(r.out_tokens),
      tokens: Number(r.in_tokens) + Number(r.out_tokens),
      spend: Number(r.spend), credits: Number(r.credits ?? 0),
      free: hasFreeTier(r.model),
      freeLeft: hasFreeTier(r.model) ? Math.max(0, 500000 - Number(r.in_tokens) - Number(r.out_tokens)) : 0,
    })),
  });
});
