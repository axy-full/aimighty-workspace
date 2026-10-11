import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { engineHealth, holdOverrunsSince, providerFailuresSince } from "@/lib/meter";

export const dynamic = "force-dynamic";

/**
 * Engine health across every workspace: what ran, what failed, how long it
 * took — and, for failed jobs on the platform's keys, what each provider said
 * it did with the charge; and, over thirty days, the takes whose engine charged
 * past the hold a person approved, with the dollars the platform absorbed for
 * them (lib/cinemaHold.ts). The platform owner's desk only.
 */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const now = Date.now();
  const [day, week, failures, overruns] = await Promise.all([engineHealth(now - 86_400_000), engineHealth(now - 7 * 86_400_000), providerFailuresSince(now - 7 * 86_400_000),
    holdOverrunsSince(now - 30 * 86_400_000)]);
  return NextResponse.json({ day, week, failures, overruns }, { headers: { "Cache-Control": "private, no-store" } });
});
