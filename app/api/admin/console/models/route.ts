import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { consoleModels } from "@/lib/platformConsole.server";

export const dynamic = "force-dynamic";

/**
 * What the platform owner may pick as a default: engines in the registry with a working key, priced by the product's own rate
 * path, and the text models that key can call, priced from the catalogue. Saving a pick goes through the platform layer
 * (app/api/admin/platform-layer, key `models`), as it always did.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json(await consoleModels(), { headers: { "Cache-Control": "no-store" } });
});
