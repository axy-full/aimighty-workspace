import { NextResponse } from "next/server";
import { listPlatformAssets } from "@/lib/platform";
import { DEMO_PRODUCTION, demoMediaUrl } from "@/lib/demoProduction";

export const dynamic = "force-dynamic";

/** The platform's demo production, readable signed out: platform data only, with each take's picture resolved. */
export async function GET() {
  const published = new Set((await listPlatformAssets("previews/").catch(() => [])).map((a) => a.key.replace(/^previews\//, "")));
  return NextResponse.json({
    production: {
      ...DEMO_PRODUCTION,
      takes: DEMO_PRODUCTION.takes.map((t) => ({ ...t, url: demoMediaUrl(t.previewKey, published), fromPreview: published.has(t.previewKey) })),
    },
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}
