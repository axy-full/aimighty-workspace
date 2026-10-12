import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { creditsApply } from "@/lib/credits";
import { creditsByBoard } from "@/lib/creditUsage";
import { monthRange } from "@/lib/statements";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/boards?month=2026-10 — what each board settled that month, in credits (lib/creditUsage.ts creditsByBoard).
 * An owner's or admin's: spend by board is the workspace's, and a member reads only their own spend (GET /api/usage/people), so a member is refused (owner rule, 11 Oct 2026: members get only their own usage). Read-only, this workspace only. A workspace that does not pay in credits (the house) gets no rows: it is never shown
 * credit figures, and its vendor dollars are not this route's to give.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const month = new URL(req.url).searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "A month looks like 2026-10." }, { status: 400 });
  const headers = { "Cache-Control": "private, no-store" };
  if (!creditsApply(requireTenant())) return NextResponse.json({ unit: "usd", month, boards: [] }, { headers });
  return NextResponse.json({ unit: "credits", month, boards: await creditsByBoard(range) }, { headers });
});
