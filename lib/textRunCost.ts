import { platformDb, platformReady } from "./platform";
import { creditsApply } from "./credits";
import { currentTenant } from "./tenant";

/**
 * What a finished paid-text run cost, in the unit the workspace pays in.
 *
 * A workspace on credits is told what the ledger BILLED it — the meter
 * event's `billed_credits`, written when the run settled — and never the
 * engine's dollars, which next to a credit price give the margin away. A
 * workspace on its own keys pays its vendor in dollars and is told those.
 *
 * `credits: null` means the meter has not settled the row (a completion the
 * meter failed to record is retried on the next pass); the caller shows
 * nothing rather than a zero it cannot vouch for.
 */
export type TextRunCost = { credits: number | null } | { costUsd: number };

export function publicTextCost(inCredits: boolean, costUsd: number, billedCredits: number | null | undefined): TextRunCost {
  if (!inCredits) return { costUsd };
  return { credits: billedCredits == null || !Number.isFinite(Number(billedCredits)) ? null : Number(billedCredits) };
}

export async function textRunCost(run: { id: string; costUsd: number }): Promise<TextRunCost> {
  const workspace = currentTenant()?.workspace;
  if (!workspace || !creditsApply(workspace)) return publicTextCost(false, run.costUsd, null);
  await platformReady();
  const row = (await platformDb().execute({
    sql: "SELECT billed_credits FROM meter_events WHERE id = ? AND workspace_id = ?",
    args: [run.id, workspace.id],
  }).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0] as { billed_credits?: number | null } | undefined;
  return publicTextCost(true, run.costUsd, row?.billed_credits ?? null);
}
