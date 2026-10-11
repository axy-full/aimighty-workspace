import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformReady } from "@/lib/platform";
import { archiveAndDelete } from "@/lib/archive";
import { accountTransaction, accountFailure } from "@/lib/accountDb";
import { securityAuditStatement } from "@/lib/securityAudit";
import { inviteRef } from "@/lib/teamAdmins";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/**
 * Withdraw an invitation that hasn't been used. The link stops working at
 * once, but the row (who was asked, by whom, as what) is kept whole in the
 * platform database's archive, never erased (lib/archive.ts).
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { code } = await params;
  try {
    /* The withdrawal and its history line land together; nothing withdrawn, no line. */
    await accountTransaction(async (tx) => {
      const gone = await archiveAndDelete(tx, "workspace_invites", "code = ? AND workspace_id = ? AND used_at IS NULL", [code, ws.id], { reason: "invite revoked", by: got.user.id });
      if (gone > 0) await tx.execute(securityAuditStatement({ workspaceId: ws.id, actorId: got.user.id, action: "invite.revoked", targetType: "invite", targetId: inviteRef(code) }));
    });
  } catch (error) { return accountFailure(error); }
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });
