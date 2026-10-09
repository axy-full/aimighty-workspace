import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { rendersAtRiskDesk } from "@/lib/rendersAtRisk";

export const dynamic = "force-dynamic";

/**
 * Renders at risk, for the platform owner's desk: how many paid renders have
 * had no stored copy for over an hour, the oldest, and the list
 * (lib/rendersAtRisk.ts). Ids, names and timings only; no provider link.
 * Nobody but the platform owner is answered.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json(await rendersAtRiskDesk(), { headers: { "Cache-Control": "private, no-store" } });
});
