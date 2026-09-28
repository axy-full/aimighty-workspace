import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import {
  convertAllCreditBalances, convertCreditBalance, listCreditConversions,
  reverseAllCreditConversions, reverseCreditConversion,
} from "@/lib/creditConversion";

export const dynamic = "force-dynamic";

/**
 * Restating balances at a new price of a credit (lib/creditConversion.ts),
 * from the platform owner's desk. Run once, at the moment CREDIT_USD changes.
 *
 *   GET                         the record, newest first (?workspace=<id> for one)
 *   POST { action: "convert", fromUsd, toUsd, workspaceId?, dryRun? }
 *   POST { action: "reverse", workspaceId?, dryRun? }
 *
 * A dry run unless the body says `dryRun: false`: what would change, per
 * workspace, and nothing written. Converting twice converts once.
 */
const price = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
};

export const GET = recoveryRoute(async function GET(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const workspace = new URL(req.url).searchParams.get("workspace") || undefined;
  return NextResponse.json({ conversions: await listCreditConversions(workspace) });
});

export const POST = recoveryRoute(async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun !== false;
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null;
  const by = got.user.id;
  if (body.action === "convert") {
    const fromUsd = price(body.fromUsd), toUsd = price(body.toUsd);
    if (fromUsd == null || toUsd == null)
      return NextResponse.json({ error: "Name both prices of a credit, in dollars: fromUsd and toUsd." }, { status: 400 });
    const results = workspaceId
      ? [await convertCreditBalance(workspaceId, { fromUsd, toUsd, by, dryRun })]
      : await convertAllCreditBalances({ fromUsd, toUsd, by, dryRun });
    return NextResponse.json({ dryRun, results });
  }
  if (body.action === "reverse") {
    const results = workspaceId
      ? [await reverseCreditConversion(workspaceId, { by, dryRun })]
      : await reverseAllCreditConversions({ by, dryRun });
    return NextResponse.json({ dryRun, results });
  }
  return NextResponse.json({ error: "The action is convert or reverse." }, { status: 400 });
});
