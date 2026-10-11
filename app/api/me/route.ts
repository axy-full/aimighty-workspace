import { NextResponse } from "next/server";
import { creditState, creditsApply } from "@/lib/credits";
import { requireUser, isPlatformOwner, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { effectiveModels } from "@/lib/defaultModels";
import { getPlatformLayer } from "@/lib/platform";
import { buildRateTable } from "@/lib/rateTable.server";
import { newInterfaceFor } from "@/lib/newInterface.server";
import { accountTransaction, accountFailure } from "@/lib/accountDb";
import { platformReady, now } from "@/lib/platform";
import { repairPendingMemberships } from "@/lib/teamInvitations";

export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id, name, email, role } = got.user;
  /* `owner` is decided here, against the server's own idea of who owns the
     workspace, so the client never has to carry that address. */
  const store = currentTenant();
  if (store?.mfaRequired) return NextResponse.json({
    id, name, email, role, owner: got.user.owner, superAdmin: false,
    mfaRequired: true, securityUrl: "/account/security",
    workspace: store.workspace ? { id: store.workspace.id, name: store.workspace.name, slug: store.workspace.slug } : null,
    workspaces: store.workspaces ?? [], credits: null, models: null, setup: null,
  }, { headers: { "Cache-Control": "private, no-store" } });
  return NextResponse.json({
    id, name, email, role,
    owner: got.user.owner, superAdmin: await isPlatformOwner(got.user),
    workspace: store?.workspace ? { id: store.workspace.id, name: store.workspace.name, slug: store.workspace.slug, platformKeys: store.workspace.usesPlatformKeys, suspended: Boolean(store.workspace.suspendedAt), suspendedReason: store.workspace.suspendedReason, internalTest: Boolean(store.workspace.internalTest), newInterface: await newInterfaceFor(store.workspace) } : null,
    workspaces: store?.workspaces ?? [],
    credits: await creditState().catch(() => null),
    /* The rates this browser may see, already in the unit this workspace
       pays in. Every workspace is handed credits, except the house workspace
       (lib/houseWorkspace.ts), which is never billed in credits and reads the
       engines' dollars, as its layout and shell already do (creditsApply).
       The vendor's dollars and the margin never cross the wire together,
       which is what §2 means by margin never being shown. */
    rates: buildRateTable(creditsApply(store?.workspace) || !store?.workspace ? "cr" : "usd"),
    models: store?.workspace ? await effectiveModels().catch(() => null) : null,
    setup: (await getPlatformLayer().catch(() => null))?.setup ?? null,
  });
}, { allowMfaEnrollment: true });

/**
 * Change the signed-in person's own name (Settings › Profile). Theirs alone: the route takes no id, so no one sets another's. The
 * name is the account's, so it changes in every workspace they belong to (each copy is refreshed by the membership mirror, as a
 * role change is). Their address changes only through the emailed flow, and there is no photo to set.
 */
export const PATCH = withTenant(async function PATCH(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 80) return NextResponse.json({ error: "Use a name between 1 and 80 characters." }, { status: 400 });
  await platformReady();
  try {
    await accountTransaction(async (tx) => {
      await tx.execute({ sql: "UPDATE accounts SET name=? WHERE id=? AND deleted_at IS NULL", args: [name, got.user.id] });
      await tx.execute({
        sql: `INSERT INTO membership_mirrors(workspace_id,account_id,updated_at)
              SELECT workspace_id, account_id, ? FROM memberships WHERE account_id=?
              ON CONFLICT(workspace_id,account_id) DO UPDATE SET updated_at=excluded.updated_at`,
        args: [now(), got.user.id],
      });
    });
  } catch (error) { return accountFailure(error); }
  await repairPendingMemberships(got.user.id).catch(() => {});
  return NextResponse.json({ ok: true, name });
}, { requireRequestScope: true });
