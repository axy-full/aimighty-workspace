import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { creditUsd } from "@/lib/creditTerms";
import { billingReady } from "@/lib/billingLedger";
import { platformDb } from "@/lib/platform";
import { ledgerUnitTx } from "@/lib/ledgerUnit";
import {
  convertAllCredits, listCreditConversions, reverseAllCredits, unitFactor, type ShortfallDecision,
} from "@/lib/creditConversion";

export const dynamic = "force-dynamic";

/**
 * Restating the credit record in a new price of a credit (lib/creditConversion.ts).
 * The platform owner only. A dry run unless the body says `dryRun: false`.
 *
 *   GET   the record, newest first (?workspace=<id> for one), the ledger's unit and CREDIT_USD.
 *   POST  { action: "convert", fromUnitUsd, cutoverAt, decisions?, workspaceId?, dryRun? }
 *         Per row (owner, 5 October 2026): `cutoverAt` (ms or ISO) is when the price moved, the
 *         first production build at the old-new price. The new unit is CREDIT_USD as this
 *         deployment runs (`toUnitUsd` is echoed; a dry run may name another to preview before the
 *         price is changed). A dry run also shows the uniform ×factor figures beside it, for
 *         comparison only. `decisions` is { [workspaceId]: "goodwill" | "apply" } for every
 *         workspace the dry run lists under `needsDecision`; one left out is skipped.
 *   POST  { action: "reverse", workspaceId?, dryRun? }
 */
const price = (v: unknown): number | null => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
};
const instant = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
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
  return NextResponse.json({ creditUsd: creditUsd(), ledgerUnitUsd: await ledgerUnit(), conversions: await listCreditConversions(workspace) });
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
      return NextResponse.json({ error: "Give cutoverAt: when the price moved (ms or ISO)." }, { status: 400 });
    const decisions: Record<string, ShortfallDecision> = {};
    for (const [id, d] of Object.entries((body.decisions ?? {}) as Record<string, unknown>)) {
      if (d !== "goodwill" && d !== "apply") return NextResponse.json({ error: `decisions.${id} is goodwill or apply.` }, { status: 400 });
      decisions[id] = d;
    }
    const echo = { fromUnitUsd, toUnitUsd, factor, creditUsd: creditUsd(), cutoverAt, decisions };
    const perRow = await convertAllCredits({ fromUsd: fromUnitUsd, toUsd: toUnitUsd, mode: "per-row", cutoverAt, decisions, by, dryRun, workspaceId });
    if (!dryRun) return NextResponse.json({ ...echo, ...perRow });
    /* The comparison column: the same record ×factor throughout. Never a real run. */
    const uniform = await convertAllCredits({ fromUsd: fromUnitUsd, toUsd: toUnitUsd, mode: "uniform", by, dryRun: true, workspaceId });
    return NextResponse.json({ ...echo, ...perRow, comparison: { uniform: { totals: uniform.totals,
      results: uniform.results.map((r) => ({ workspaceId: r.workspaceId, status: r.status, before: r.before?.balance ?? null, after: r.after?.balance ?? null,
        usdBefore: r.before?.balanceUsd ?? null, usdAfter: r.after?.balanceUsd ?? null })) } } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
});
