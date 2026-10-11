import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { sitePatch } from "@/lib/site/settings";
import { SiteSettingsError, listNewInterfaceOff, readSite, writeSite } from "@/lib/site/settings.server";

export const dynamic = "force-dynamic";

/**
 * The site-wide switches for signed-out visitors (lib/site/settings.ts): open sign-up, Guest Home and the sample's
 * workspace, and the new interface's way back (everyone, or one workspace). The platform owner only, in a browser session (requireSuperAdmin refuses API tokens). Off by default;
 * nothing here touches money or plans.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json({ ...(await readSite()), newInterfaceOff: await listNewInterfaceOff() }, { headers: { "Cache-Control": "no-store" } });
});

export const PATCH = recoveryRoute(async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const checked = sitePatch(await req.json().catch(() => null));
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    const site = await writeSite(checked.patch, got.user.id);
    return NextResponse.json({ ok: true, ...site, newInterfaceOff: await listNewInterfaceOff() });
  } catch (error) {
    if (error instanceof SiteSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
