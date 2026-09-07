import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { workspaceLimits, standing } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** The workspace's limits and where it stands against them right now. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const [limits, st] = await Promise.all([workspaceLimits(), standing()]);
  return NextResponse.json({ limits, standing: st });
});
