import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { engineHealth } from "@/lib/meter";

export const dynamic = "force-dynamic";

/** Engine health across every workspace: what ran, what failed, how long it took. */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const now = Date.now();
  const [day, week] = await Promise.all([engineHealth(now - 86_400_000), engineHealth(now - 7 * 86_400_000)]);
  return NextResponse.json({ day, week });
});
