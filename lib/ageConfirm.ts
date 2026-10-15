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
 * Not sign-ups, so not asked: the one-time import of an older install's users (lib/platform.ts), and the preview seed's placeholder accounts that nobody can sign in to (lib/previewSeed.ts).
 */
export const AGE_CONFIRM_LABEL = "I'm 18 or older and agree to the Terms";
export const AGE_CONFIRM_REFUSAL = "Tick the box to confirm you're 18 or older and agree to the Terms.";

/** The history line for a new account: its id and the moment, written in the transaction that creates the account. */
export function ageConfirmedStatement(accountId: string): InStatement {
  return securityAuditStatement({ workspaceId: null, actorId: accountId, action: "account.age_confirmed", targetType: "account", targetId: accountId });
}
