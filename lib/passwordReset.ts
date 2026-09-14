import { securityAuditStatement } from "./securityAudit";
import { insertAccountSession } from "./accountSecurity";
import { accountTransaction, AccountError } from "./accountDb";
import { hashPassword, passwordProblem, tokenHash } from "./auth";
import { now } from "./platform";

/** Consume every outstanding reset, replace the password and all sessions together. */
export async function resetAccountPassword(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(problem);
  const passwordHash = hashPassword(password);
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
      sql: "DELETE FROM account_recovery_batches WHERE account_id=?",
      args: [accountId],
    });
    await tx.execute({
      sql: "DELETE FROM session_security WHERE token_hash IN (SELECT token_hash FROM p_sessions WHERE account_id=?)",
      args: [accountId],
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
    const security = (
      await tx.execute({
        sql: "SELECT enabled_at FROM account_security WHERE account_id=?",
        args: [accountId],
      })
    ).rows[0];
    // A mailbox/password reset is never a replacement for the second factor.
    const session =
      security?.enabled_at != null
        ? null
        : await insertAccountSession(tx, {
            accountId,
            workspaceId:
              membership?.workspace_id == null
                ? null
                : String(membership.workspace_id),
          });
    await tx.execute(
      securityAuditStatement({
        workspaceId:
          membership?.workspace_id == null
            ? null
            : String(membership.workspace_id),
        actorId: accountId,
        action: "account.password_reset",
        targetType: "account",
        targetId: accountId,
      }),
    );
    return { session, name: String(row.name) };
  });
}
