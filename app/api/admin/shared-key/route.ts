import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { sharedKeyDesk } from "@/lib/sharedKeyDesk";

export const dynamic = "force-dynamic";

/**
 * The shared provider key, for the platform owner's desk: its pool, the takes
 * waiting on a key that changed, and the latest requests with their
 * request_id and correlation id. Nobody but the platform owner is answered.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json(await sharedKeyDesk(), { headers: { "Cache-Control": "private, no-store" } });
});
