import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { creditsApply } from "@/lib/credits";
import { creditsByPerson } from "@/lib/creditUsage";
import type { LedgerViewer } from "@/lib/usageLedger";
import { monthRange } from "@/lib/statements";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/people?month=2026-10 — what each person settled that month, in credits (lib/creditUsage.ts creditsByPerson).
 * An owner or admin reads a row per person; a member reads only their own row (`you: true`), never anyone else's. Read-only,
 * this workspace only. The house, which pays in dollars, gets no rows.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const month = new URL(req.url).searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "A month looks like 2026-10." }, { status: 400 });
  const headers = { "Cache-Control": "private, no-store" };
  if (!creditsApply(requireTenant())) return NextResponse.json({ unit: "usd", month, people: [] }, { headers });
  const viewer: LedgerViewer = { id: got.user.id, admin: got.user.role === "admin" || got.user.owner };
  return NextResponse.json({ unit: "credits", month, people: await creditsByPerson(range, viewer) }, { headers });
});
