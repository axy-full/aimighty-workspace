import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformReady, now } from "@/lib/platform";
import { accountTransaction, accountFailure, AccountError } from "@/lib/accountDb";
import { securityAuditStatement } from "@/lib/securityAudit";
import { assertAnotherAdmin } from "@/lib/teamAdmins";
import { ownerMaskFor } from "@/lib/platformOwnerPrivacy";

export const dynamic = "force-dynamic";

/**
 * Leave the workspace the session is in (Settings › Workspace › Leave workspace). The account lives on and keeps any other
 * workspace; its renders here keep its name. Nobody leaves for someone else: this removes the signed-in person's own
 * membership only. The owner cannot leave (the workspace is theirs: they delete it), and the last admin cannot either.
 */
export const POST = withTenant(async function POST() {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const id = got.user.id;
  const mask = await ownerMaskFor(ws);
  try {
    await accountTransaction(async (tx) => {
      const mine = (await tx.execute({ sql: "SELECT role FROM memberships WHERE workspace_id=? AND account_id=?", args: [ws.id, id] })).rows[0];
      if (!mine) throw new AccountError("You are not a member of this workspace.", 404);
      if (mine.role === "owner") throw new AccountError("You own this workspace, so you can't leave it. Delete it instead.", 400);
      if (mine.role === "admin") await assertAnotherAdmin(tx, ws.id, id, mask);
      await tx.execute({ sql: "DELETE FROM memberships WHERE workspace_id=? AND account_id=? AND role<>'owner'", args: [ws.id, id] });
      await tx.execute({ sql: "DELETE FROM p_sessions WHERE account_id=? AND workspace_id=?", args: [id, ws.id] });
      await tx.execute({ sql: "DELETE FROM membership_mirrors WHERE workspace_id=? AND account_id=?", args: [ws.id, id] });
      await tx.execute(securityAuditStatement({ workspaceId: ws.id, actorId: id, action: "member.left", targetType: "member", targetId: id }));
    });
  } catch (error) { return accountFailure(error); }
  /* As a removal does: the workspace's own copy of this person stops working too. */
  const { db } = await import("@/lib/db");
  await db().batch([
    { sql: "UPDATE users SET disabled=1,deleted_at=? WHERE id=?", args: [now(), id] },
    { sql: "UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", args: [now(), id] },
  ], "write").catch(() => {});
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });
