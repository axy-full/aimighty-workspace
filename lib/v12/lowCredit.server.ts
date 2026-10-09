import { creditsApply } from "@/lib/credits";
import { signupCredits } from "@/lib/creditTerms";
import { getPlatformLayer, platformDb, platformReady } from "@/lib/platform";
import type { TenantWorkspace } from "@/lib/tenant";

/**
 * What the low-credit rule (lib/v12/lowCredit.ts) measures the balance against, for the session (lib/shell/bootstrap.server.ts).
 *
 * Read-only: two SELECTs, scoped to the workspace, on tables the billing ledger already keeps. Nothing is granted,
 * synced or charged here. Only read for a workspace with the new interface on (lib/shell/bootstrap.server.ts).
 * `billing_cycles` has no index on workspace_id yet (a migration follow-up); the welcome read uses credit_grants_ws.
 *  - planIncludedCredits: the credits the current billing cycle included (`billing_cycles.credits`, written when a paid
 *    period starts, lib/billingLedger.ts materializeCycles), or 0 when no cycle is running: Invite, no subscription, or a
 *    plan the admin labelled without payment, which grants nothing (docs/subscribed-workspaces.md).
 *  - welcomeGrant: the welcome credits this workspace was granted (`credit_grants` of kind "welcome"), or, when it has
 *    none on record, what the platform grants a new workspace (`caps.signupCredits`, else SIGNUP_CREDITS), the same
 *    figure lib/workspaceProvisioning.ts approvedWelcomeCredits grants.
 * Null for a workspace that does not pay in credits (the house workspace): it never sees the chip.
 */
export type LowCreditBase = { planIncludedCredits: number; welcomeGrant: number };

export async function lowCreditBaseFor(ws: TenantWorkspace, at = Date.now()): Promise<LowCreditBase | null> {
  if (!creditsApply(ws)) return null;
  await platformReady();
  const db = platformDb();
  /* Each read on its own: a ledger without its cycles table still gives the welcome base, and the other way round. */
  const [cycleRead, welcomeRead] = await Promise.allSettled([
    db.execute({
      sql: `SELECT credits FROM billing_cycles WHERE workspace_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1`,
      args: [ws.id, at, at],
    }),
    db.execute({
      sql: `SELECT COALESCE(SUM(credits), 0) AS n FROM credit_grants WHERE workspace_id = ? AND kind = 'welcome'`,
      args: [ws.id],
    }),
  ]);
  const cycle = cycleRead.status === "fulfilled" ? cycleRead.value.rows[0] as { credits?: unknown } | undefined : undefined;
  const welcome = welcomeRead.status === "fulfilled" ? welcomeRead.value.rows[0] as { n?: unknown } | undefined : undefined;
  const included = Number(cycle?.credits ?? 0);
  const granted = Number(welcome?.n ?? 0);
  const welcomeGrant = Number.isFinite(granted) && granted > 0 ? granted
    : (await getPlatformLayer().catch(() => null))?.caps.signupCredits ?? signupCredits();
  return { planIncludedCredits: Number.isFinite(included) && included > 0 ? included : 0, welcomeGrant };
}
