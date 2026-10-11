import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { consoleOverview } from "@/lib/platformConsole.server";

export const dynamic = "force-dynamic";

/** The platform console's Overview and its badges: counts across the deployment. The platform owner only, in a browser session (requireSuperAdmin refuses API tokens). */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json(await consoleOverview(), { headers: { "Cache-Control": "no-store" } });
});
