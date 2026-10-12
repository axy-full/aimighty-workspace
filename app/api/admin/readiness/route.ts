import { NextResponse } from "next/server";
import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { deploymentReadiness } from "@/lib/deploymentReadiness";
import { platformDb } from "@/lib/platform";
import { operationStatus } from "@/lib/operationLease";
import { RECONCILIATION_OPERATION } from "@/lib/reconciliation";
import { latestWorkerProbe } from "@/lib/workerProbe";
import { vercelIdentityInProduction, vercelIdentityProblem } from "@/lib/vercelGuard";

export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET(req: Request) {
  const auth = await requireSuperAdmin();
  if (auth.response) return auth.response;
  const includeBilling = new URL(req.url).searchParams.get("billing") === "1";
  const configuration = deploymentReadiness(process.env, { includeBilling });
  const reconciliation = await operationStatus(platformDb(), RECONCILIATION_OPERATION);
  const worker = await latestWorkerProbe();
  /* Production has no Vercel identity (lib/vercelGuard.ts): a separate finding, so the readiness list above is unchanged. */
  const vercelIdentity = vercelIdentityProblem();
  return NextResponse.json({ ...configuration, ready: configuration.ready && !vercelIdentity, ...(vercelIdentity ? { vercelIdentity: { names: vercelIdentityInProduction(), problem: vercelIdentity } } : {}), reconciliation, worker }, {
    headers: { "Cache-Control": "no-store" },
  });
});
