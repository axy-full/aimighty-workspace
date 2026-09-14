import { securityAuditStatement } from "./securityAudit";
import { randomBytes } from "node:crypto";
import { accountTransaction, AccountError } from "./accountDb";
import { hashPassword, passwordProblem, tokenHash } from "./auth";
import { now } from "./platform";

/** Consume every outstanding reset, replace the password and all sessions together. */
export async function resetAccountPassword(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  const passwordHash = hashPassword(password);
  const session = randomBytes(32).toString("base64url");
  return accountTransaction(async (tx) => {
    const at = now();
    const row = (
      await tx.execute({
        sql: `SELECT a.id,a.name FROM password_resets r JOIN accounts a ON a.id=r.user_id
        WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND a.disabled=0 AND a.deleted_at IS NULL`,
        args: [tokenHash(token), at],
      })
    ).rows[0];
    if (!row)
      throw new AccountError(
        "That reset link is invalid, expired or already used. Ask for a new one.",
        410,
      );
    const accountId = String(row.id);
    await tx.execute({
      sql: "UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL",
      args: [at, accountId],
    });
    await tx.execute({
      sql: "UPDATE accounts SET password_hash=?,locked_until=NULL,failed_count=0 WHERE id=?",
      args: [passwordHash, accountId],
    });
    await tx.execute({
      sql: "DELETE FROM p_sessions WHERE account_id=?",
      args: [accountId],
    });
    const membership = (
      await tx.execute({
        sql: `SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.account_id=? AND m.disabled=0 AND w.deleted_at IS NULL ORDER BY m.created_at LIMIT 1`,
        args: [accountId],
      })
    ).rows[0];
    await tx.execute({
      sql: "INSERT INTO p_sessions(token_hash,account_id,workspace_id,created_at,expires_at) VALUES(?,?,?,?,?)",
      args: [
        tokenHash(session),
        accountId,
        membership?.workspace_id == null
          ? null
          : String(membership.workspace_id),
        at,
        at + 30 * 86400_000,
      ],
    });
    await tx.execute(securityAuditStatement({ workspaceId: membership?.workspace_id == null ? null : String(membership.workspace_id), actorId: accountId, action: "account.password_reset", targetType: "account", targetId: accountId }));
    return { session, name: String(row.name) };
  });
}
