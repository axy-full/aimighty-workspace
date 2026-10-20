import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { houseCapView } from "@/lib/houseCap";

export const dynamic = "force-dynamic";

/**
 * The house workspace's monthly engine cap and the month so far (lib/houseCap.ts), for its Credits & billing screen. Any other
 * workspace reads null: it has no house cap. Read-only; the cap is set from the platform desk by the platform owner alone.
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  return NextResponse.json({ houseCap: await houseCapView() }, { headers: { "Cache-Control": "no-store" } });
});
