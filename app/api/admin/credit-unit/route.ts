import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { creditUsd } from "@/lib/creditTerms";
import { billingReady } from "@/lib/billingLedger";
import { platformDb } from "@/lib/platform";
import { ledgerUnitTx, pausedSinceTx } from "@/lib/ledgerUnit";
import type { CapChoice } from "@/lib/creditConversionTenant";
import {
  REAL_FROM_USD, REAL_TO_USD, convertAllCredits, listCreditConversions, reverseAllCredits, unitFactor, type ShortfallDecision,
} from "@/lib/creditConversion";

export const dynamic = "force-dynamic";

/**
 * Restating the credit record in a new price of a credit (lib/creditConversion.ts).
 * The platform owner only. A dry run unless the body says `dryRun: false`.
 *
 *   GET   the record, newest first (?workspace=<id> for one), the ledger's unit and CREDIT_USD.
 *   POST  { action: "convert", fromUnitUsd, cutoverAt, endAt?, decisions?, caps?, skipTenant?, workspaceId?, dryRun? }
 *         Per row (owner, 5 October 2026). `cutoverAt` (ms, or ISO with Z or an offset) is when
 *         the price moved to the old price: the first production build at it. `endAt` closes that
 *         window; default, when an instance first ran at the new price (billing_unit.paused_since).
 *         The new unit is CREDIT_USD as deployed (`toUnitUsd` is echoed; a dry run may name another
 *         to preview, and held takes are priced at it). A real run is 0.80 → 0.10 only, and
 *         `decisions` ({ [workspaceId]: "goodwill" | "apply" }) must cover every workspace the dry
 *         run lists under `needsDecision`. `caps` ({ "<workspaceId>/<table>:<id>": "keep" | "x8" },
 *         "platform/caps:defaultCapCredits" for the platform's) chooses per stored cap; default keep.
 *         `skipTenant` names workspaces whose own database half is to be marked skipped. A dry run
 *         also shows uniform ×factor figures beside it, for comparison only.
 *   POST  { action: "reverse", workspaceId?, dryRun? }
 */
const price = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
};
/** Milliseconds, or ISO with Z or an offset: a time with no zone would be read in the server's. */
const instant = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(String(v).trim())) return null;
  const n = Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

async function ledgerUnit() {
  await billingReady();
  return ledgerUnitTx(platformDb());
}

export const GET = recoveryRoute(async function GET(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const workspace = new URL(req.url).searchParams.get("workspace") || undefined;
  await billingReady();
  return NextResponse.json({ creditUsd: creditUsd(), ledgerUnitUsd: await ledgerUnit(), pausedSince: await pausedSinceTx(platformDb()),
    conversions: await listCreditConversions(workspace) });
});

export const POST = recoveryRoute(async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun !== false;
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null;
  const by = got.user.id;
  try {
    if (body.action === "reverse")
      return NextResponse.json({ creditUsd: creditUsd(), ...(await reverseAllCredits({ by, dryRun, workspaceId })) });
    if (body.action !== "convert") return NextResponse.json({ error: "The action is convert or reverse." }, { status: 400 });

    const fromUnitUsd = price(body.fromUnitUsd);
    if (fromUnitUsd == null) return NextResponse.json({ error: "Name the price the record counts in now: fromUnitUsd, in dollars." }, { status: 400 });
    const asked = dryRun ? price(body.toUnitUsd) : null;
    if (!dryRun && body.toUnitUsd != null && price(body.toUnitUsd) !== creditUsd())
      return NextResponse.json({ error: `A real run converts to CREDIT_USD as deployed, $${creditUsd()}.` }, { status: 400 });
    const toUnitUsd = asked ?? creditUsd();
    const factor = unitFactor(fromUnitUsd, toUnitUsd);
    if (factor == null)
      return NextResponse.json({ error: `$${fromUnitUsd} is not a whole number of $${toUnitUsd} credits. Change CREDIT_USD and redeploy first.`, fromUnitUsd, toUnitUsd }, { status: 400 });
    const cutoverAt = instant(body.cutoverAt);
    if (body.mode != null && body.mode !== "per-row" && !(dryRun && body.mode === "uniform"))
      return NextResponse.json({ error: "A real run is per row; uniform is a dry-run comparison only." }, { status: 400 });
    if (cutoverAt == null)
      return NextResponse.json({ error: "Give cutoverAt: when the price moved, in ms or ISO with Z or an offset." }, { status: 400 });
    const endAt = body.endAt == null ? null : instant(body.endAt);
    if (body.endAt != null && endAt == null)
      return NextResponse.json({ error: "endAt is ms, or ISO with Z or an offset." }, { status: 400 });
    if (!dryRun && !(fromUnitUsd === REAL_FROM_USD && toUnitUsd === REAL_TO_USD))
      return NextResponse.json({ error: `A real run is $${REAL_FROM_USD} → $${REAL_TO_USD} only.` }, { status: 400 });
    const caps: Record<string, CapChoice> = {};
    for (const [id, c] of Object.entries((body.caps ?? {}) as Record<string, unknown>)) {
      if (c !== "keep" && c !== "x8") return NextResponse.json({ error: `caps.${id} is keep or x8.` }, { status: 400 });
      caps[id] = c;
    }
    const skipTenant = Array.isArray(body.skipTenant) ? body.skipTenant.filter((x: unknown): x is string => typeof x === "string") : [];
    const decisions: Record<string, ShortfallDecision> = {};
    for (const [id, d] of Object.entries((body.decisions ?? {}) as Record<string, unknown>)) {
      if (d !== "goodwill" && d !== "apply") return NextResponse.json({ error: `decisions.${id} is goodwill or apply.` }, { status: 400 });
      decisions[id] = d;
    }
    const echo = { fromUnitUsd, toUnitUsd, factor, creditUsd: creditUsd(), decisions, capsChosen: caps };
    const perRow = await convertAllCredits({ fromUsd: fromUnitUsd, toUsd: toUnitUsd, mode: "per-row", cutoverAt, endAt, decisions, caps, skipTenant, by, dryRun, workspaceId,
      previewUnitUsd: dryRun ? toUnitUsd : undefined });
    if (!dryRun) return NextResponse.json({ ...echo, ...perRow });
    /* The comparison column: the same record ×factor throughout. Never a real run. */
    const uniform = await convertAllCredits({ fromUsd: fromUnitUsd, toUsd: toUnitUsd, mode: "uniform", endAt, by, dryRun: true, workspaceId });
    return NextResponse.json({ ...echo, ...perRow, comparison: { uniform: { totals: uniform.totals,
      results: uniform.results.map((r) => ({ workspaceId: r.workspaceId, status: r.status, before: r.before?.balance ?? null, after: r.after?.balance ?? null,
        usdBefore: r.before?.balanceUsd ?? null, usdAfter: r.after?.balanceUsd ?? null })) } } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
});
