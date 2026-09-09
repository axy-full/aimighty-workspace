import { NextResponse } from "next/server";
import { creditState } from "@/lib/credits";
import { requireUser, isPlatformOwner, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { creditsApply } from "@/lib/credits";

export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id, name, email, role } = got.user;
  /* `owner` is decided here, against the server's own idea of who owns the
     workspace, so the client never has to carry that address. */
  const store = currentTenant();
  return NextResponse.json({
    id, name, email, role,
    owner: got.user.owner, superAdmin: await isPlatformOwner(got.user),
    workspace: store?.workspace ? { id: store.workspace.id, name: store.workspace.name, slug: store.workspace.slug, platformKeys: store.workspace.usesPlatformKeys, suspended: Boolean(store.workspace.suspendedAt), suspendedReason: store.workspace.suspendedReason, internalTest: Boolean(store.workspace.internalTest) } : null,
    workspaces: store?.workspaces ?? [],
    credits: await creditState().catch(() => null),
    /* The rates this browser may see, already in the unit this workspace
       pays in. A workspace on the platform's keys is handed credits; one on
       its own keys is handed the dollars it actually pays its vendors. The
       vendor's dollars and the margin never cross the wire together, which is
       what §2 means by margin never being shown. */
    rates: buildRateTable(creditsApply(store?.workspace) ? "cr" : "usd"),
    models: store?.workspace ? await effectiveModels().catch(() => null) : null,
    setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
  });
});
