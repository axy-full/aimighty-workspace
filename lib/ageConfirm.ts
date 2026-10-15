import type { InStatement } from "@libsql/client";
import { securityAuditStatement } from "./securityAudit";

/**
 * The 18+ confirmation at sign-up (owner, 15 Oct 2026, 20:45: "an 18+ confirmation at sign-up (a required tick: "I'm 18 or older and agree to the Terms"), stored with the date, on every sign-up path").
 *
 * One required tick. The server refuses to create an account without it (the sign-up routes and, below them, the functions that insert the account), and every account created
 * through a sign-up path gets one line in the platform database's security history, `account.age_confirmed`, written in the SAME transaction as the account: the account id and the moment,
 * nothing else (no name, email, address or text; explicit fields only, lib/securityAudit.ts). `accounts.accepted_policy_at`, the date the old tick was ticked, is still written beside it.
 * No table or column is added: the history table already exists in the platform database.
 *
 * Not sign-ups, so not asked: the one-time import of an older install's users (lib/platform.ts), and the preview seed's account for the platform owner (lib/previewSeed.ts, a preview environment's own
 * account, entered by a reset link).
 */
export { AGE_CONFIRM_LABEL, AGE_CONFIRM_REFUSAL } from "./ageConfirmText";

/**
 * The moment the tick shipped (15 Oct 2026, 16:35 UTC). An email sign-up registration is only a row until its link is opened, and a row made before this moment was begun without the tick, so it
 * is never resent or verified into an account: its owner starts sign-up again (lib/signupRegistration.ts). Every begin since sets the row's creation time to its own, so it is at or after this. Moving
 * it later is safe only up to the moment of the deploy: a begin made before the constant but after the deploy would have to start again.
 */
export const AGE_CONFIRM_SINCE = Date.UTC(2026, 9, 15, 16, 35, 0);

/** The history line for a new account: its id and the moment, written in the transaction that creates the account. */
export function ageConfirmedStatement(accountId: string): InStatement {
  return securityAuditStatement({ workspaceId: null, actorId: accountId, action: "account.age_confirmed", targetType: "account", targetId: accountId });
}
