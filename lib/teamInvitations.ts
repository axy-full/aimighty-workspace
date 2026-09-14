import { accountDbReady, accountTransaction, AccountError } from "./accountDb";
import { assertInvitationSession } from "./accountInvitationSession";
import {
  platformDb,
  now,
  newId,
  rowToWorkspace,
  getWorkspace,
  getPlatformLayer,
  mirrorUser,
} from "./platform";
import { passwordProblem, hashPassword } from "./auth";
import { ceilingFor, ceilingMessage } from "./planLimits";
import { planById } from "./plans";
import { effectivePlanId, paidPlanEntitlementTx } from "./billingLedger";
import type { WorkspaceRole, TenantWorkspace } from "./tenant";
import type { Transaction } from "@libsql/client";
import type { PlatformLayer } from "./platformLayer";

/** The platform membership is authoritative. Mirror repair survives a tenant
 * connection failure without consuming another seat or reusing an invitation. */
export async function repairPendingMemberships(accountId: string) {
  await accountDbReady();
  const pending = (
    await platformDb().execute({
      sql: "SELECT workspace_id FROM membership_mirrors WHERE account_id=?",
      args: [accountId],
    })
  ).rows;
  for (const item of pending) {
    const workspaceId = String(item.workspace_id),
      ws = await getWorkspace(workspaceId);
    if (!ws || ws.deletedAt) continue;
    const row = (
      await platformDb().execute({
        sql: `SELECT a.id,a.email,a.name,a.disabled AS account_disabled,a.deleted_at,m.role,m.disabled FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.workspace_id=? AND m.account_id=?`,
        args: [workspaceId, accountId],
      })
    ).rows[0];
    if (!row) continue;
    await mirrorUser(
      ws,
      { id: accountId, email: String(row.email), name: String(row.name) },
      String(row.role) as WorkspaceRole,
      Boolean(row.disabled || row.account_disabled || row.deleted_at),
    );
    await platformDb().execute({
      sql: "DELETE FROM membership_mirrors WHERE workspace_id=? AND account_id=?",
      args: [workspaceId, accountId],
    });
  }
}
/** Called while holding the same platform write lock as membership changes. */
export async function ensureMemberSeat(
  tx: Transaction,
  ws: TenantWorkspace,
  layer: PlatformLayer,
) {
  const paid = await paidPlanEntitlementTx(tx, ws.id, now());
  const plan = planById(layer.plans, effectivePlanId(paid, ws.planId)),
    ceiling = ceilingFor(plan, "members");
  const members = Number(
    (
      await tx.execute({
        sql: "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND disabled=0",
        args: [ws.id],
      })
    ).rows[0].n,
  );
  if (ceiling != null && members >= ceiling)
    throw new AccountError(ceilingMessage(plan!, "members", ceiling), 402);
}
export async function acceptWorkspaceInvitation(input: {
  code: string;
  password?: string;
  name?: string;
  signedInAccountId?: string;
  signedInSession?: string;
}) {
  const layer = await getPlatformLayer();
  const joined = await accountTransaction(async (tx) => {
    const inv = (
      await tx.execute({
        sql: "SELECT * FROM workspace_invites WHERE code=?",
        args: [input.code],
      })
    ).rows[0];
    if (!inv) throw new AccountError("This invitation is not valid.", 404);
    const row = (
      await tx.execute({
        sql: "SELECT * FROM workspaces WHERE id=? AND deleted_at IS NULL",
        args: [String(inv.workspace_id)],
      })
    ).rows[0];
    if (!row) throw new AccountError("This workspace no longer exists.", 410);
    const ws = rowToWorkspace(row),
      email = String(inv.email).toLowerCase();
    const existing = (
      await tx.execute({
        sql: "SELECT * FROM accounts WHERE email=?",
        args: [email],
      })
    ).rows[0];
    if (existing && (existing.disabled || existing.deleted_at))
      throw new AccountError("This account is not available.", 403);
    if (existing && String(existing.id) !== input.signedInAccountId)
      throw new AccountError(
        "This email already has an account. Sign in as that account to accept the invitation.",
        409,
      );
    if (existing)
      await assertInvitationSession(
        tx,
        String(existing.id),
        input.signedInSession,
      );
    const membership = existing
      ? (
          await tx.execute({
            sql: "SELECT role,disabled FROM memberships WHERE workspace_id=? AND account_id=?",
            args: [ws.id, String(existing.id)],
          })
        ).rows[0]
      : undefined;
    if (inv.used_at) {
      if (!existing || !membership || membership.disabled)
        throw new AccountError("This invitation has already been used.", 409);
      return { workspace: ws, accountId: String(existing.id) };
    }
    if (Number(inv.expires_at) < now())
      throw new AccountError(
        "This invitation has expired. Ask for a new one.",
        410,
      );
    const alreadyMember = membership && !membership.disabled;
    if (!alreadyMember) {
      await ensureMemberSeat(tx, ws, layer);
    }
    let accountId = existing ? String(existing.id) : "";
    if (!existing) {
      const password = String(input.password ?? ""),
        problem = passwordProblem(password);
      if (problem) throw new AccountError(problem);
      const name = String(inv.name || input.name || email.split("@")[0])
        .trim()
        .slice(0, 80);
      accountId = newId("usr");
      await tx.execute({
        sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
        args: [accountId, email, name, hashPassword(password), now()],
      });
    }
    // A second pending invite never demotes an existing owner/admin.
    if (!alreadyMember)
      await tx.execute({
        sql: `INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET role=excluded.role,disabled=0`,
        args: [
          ws.id,
          accountId,
          inv.role === "admin" ? "admin" : "member",
          now(),
        ],
      });
    await tx.execute({
      sql: "UPDATE workspace_invites SET used_at=? WHERE code=? AND used_at IS NULL",
      args: [now(), input.code],
    });
    await tx.execute({
      sql: "INSERT INTO membership_mirrors(workspace_id,account_id,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id,account_id) DO UPDATE SET updated_at=excluded.updated_at",
      args: [ws.id, accountId, now()],
    });
    return { workspace: ws, accountId };
  });
  await repairPendingMemberships(joined.accountId).catch(() => {});
  return joined;
}
