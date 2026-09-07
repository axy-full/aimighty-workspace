import { NextResponse } from "next/server";
import { creditState } from "@/lib/credits";
import { requireUser, isPlatformOwner, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer } from "@/lib/platform";

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
    workspace: store?.workspace ? { id: store.workspace.id, name: store.workspace.name, slug: store.workspace.slug, platformKeys: store.workspace.usesPlatformKeys, suspended: Boolean(store.workspace.suspendedAt), suspendedReason: store.workspace.suspendedReason } : null,
    workspaces: store?.workspaces ?? [],
    credits: await creditState().catch(() => null),
    models: store?.workspace ? await effectiveModels().catch(() => null) : null,
    setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
  });
});
