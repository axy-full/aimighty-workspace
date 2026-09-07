import { NextResponse } from "next/server";
import { withTenant } from "@/lib/auth";
import { listPlatformAssets } from "@/lib/platform";

export const dynamic = "force-dynamic";

/** The bank's neutral previews, by key — platform assets every workspace reads. */
export const GET = withTenant(async function GET() {
  const assets = await listPlatformAssets("previews/");
  const previews: Record<string, string> = {};
  for (const a of assets) {
    const key = a.key.replace(/^previews\//, "");
    previews[key] = `/api/platform/previews/${encodeURIComponent(key)}`;
  }
  return NextResponse.json({ previews, count: assets.length });
});
