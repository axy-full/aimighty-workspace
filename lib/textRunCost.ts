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
 * `credits: null` means the meter has not settled the row: there is no row
 * yet, or it is still the `running` reservation, whose `billed_credits` is the
 * ESTIMATE held against the balance, not what was billed (a completion the
 * meter failed to record is retried on the next pass). The caller shows
 * nothing rather than a figure it cannot vouch for.
 */
export type TextRunCost = { credits: number | null } | { costUsd: number };

export function publicTextCost(inCredits: boolean, costUsd: number, billedCredits: number | null | undefined, status: string | null | undefined): TextRunCost {
  if (!inCredits) return { costUsd };
  const billed = Number(billedCredits);
  return { credits: status === "succeeded" && billedCredits != null && Number.isFinite(billed) ? billed : null };
}

export async function textRunCost(run: { id: string; costUsd: number }): Promise<TextRunCost> {
  const workspace = currentTenant()?.workspace;
  if (!workspace || !creditsApply(workspace)) return publicTextCost(false, run.costUsd, null, null);
  await platformReady();
  const row = (await platformDb().execute({
    sql: "SELECT status, billed_credits FROM meter_events WHERE id = ? AND workspace_id = ?",
    args: [run.id, workspace.id],
  }).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0] as { status?: string | null; billed_credits?: number | null } | undefined;
  return publicTextCost(true, run.costUsd, row?.billed_credits ?? null, row?.status ?? null);
}
