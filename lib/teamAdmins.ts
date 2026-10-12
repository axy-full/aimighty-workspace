import type { Transaction } from "@libsql/client";
import { AccountError } from "./accountDb";
import type { OwnerMask } from "./platformOwnerPrivacy";

/**
 * A workspace always keeps an admin (Settings › People). The owner's standing is protected already; this is the rule under
 * it, read inside the same write as the change so two changes at once cannot each leave the other as "the last one".
 * The platform owner's support row (lib/platformOwnerPrivacy.ts) is not the client's admin and never counts as one.
 */
export const LAST_ADMIN = "A workspace needs at least one admin. Make someone else an admin first.";

/** Throws when taking `accountId` out of the admins (demoted, switched off, removed or leaving) would leave none. */
export async function assertAnotherAdmin(tx: Transaction, workspaceId: string, accountId: string, mask: Pick<OwnerMask, "hides">): Promise<void> {
  const rows = (await tx.execute({
    sql: `SELECT m.account_id AS id, a.email, a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.workspace_id = ? AND m.disabled = 0 AND m.role IN ('owner','admin') AND a.deleted_at IS NULL AND a.disabled = 0`,
    args: [workspaceId],
  })).rows;
  const others = rows.filter((r) => String(r.id) !== accountId && !mask.hides({ id: r.id, email: r.email }));
  if (!others.length) throw new AccountError(LAST_ADMIN, 400);
}
