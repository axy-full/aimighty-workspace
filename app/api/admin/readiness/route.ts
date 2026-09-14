import { NextResponse } from "next/server";
import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { deploymentReadiness } from "@/lib/deploymentReadiness";
import { platformDb } from "@/lib/platform";
import { operationStatus } from "@/lib/operationLease";
import { RECONCILIATION_OPERATION } from "@/lib/reconciliation";
import { latestWorkerProbe } from "@/lib/workerProbe";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET(req: Request) {
  const auth = await requireSuperAdmin();
  if (auth.response) return auth.response;
  const includeBilling = new URL(req.url).searchParams.get("billing") === "1";
  const configuration = deploymentReadiness(process.env, { includeBilling });
  const reconciliation = await operationStatus(platformDb(), RECONCILIATION_OPERATION);
  const worker = await latestWorkerProbe();
  return NextResponse.json({ ...configuration, reconciliation, worker }, {
    headers: { "Cache-Control": "no-store" },
  });
});
