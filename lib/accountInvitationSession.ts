import type { Transaction } from "@libsql/client";
import { AccountError, accountTransaction } from "./accountDb";
import { assertLiveAccountSession } from "./accountSecurity";
import { createSession } from "./auth";

/** An account ID captured before a transaction is not proof of a live session. */
export async function assertInvitationSession(
  tx: Transaction,
  accountId: string,
  session?: string,
) {
  if (!session)
    throw new AccountError("Sign in as this account to continue.", 409);
  await assertLiveAccountSession(tx, accountId, session);
}

/** Existing accounts keep their factor-verified cookie. Never issue a new
 * password-only session merely because an invitation named an existing owner. */
export async function accountInvitationSession(
  accountId: string,
  signedInAccountId?: string,
  signedInSession?: string,
) {
  if (accountId === signedInAccountId) {
    await accountTransaction((tx) =>
      assertInvitationSession(tx, accountId, signedInSession),
    );
    return { session: signedInSession!, created: false };
  }
  return { session: await createSession(accountId), created: true };
}
