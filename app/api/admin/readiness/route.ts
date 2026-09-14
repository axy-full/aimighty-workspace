import { NextResponse } from "next/server";
import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { deploymentReadiness } from "@/lib/deploymentReadiness";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET() {
  const auth = await requireSuperAdmin();
  if (auth.response) return auth.response;
  return NextResponse.json(deploymentReadiness(), {
    headers: { "Cache-Control": "no-store" },
  });
});
