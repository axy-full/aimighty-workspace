import { meter } from "../meter";
import { HOUSE_WORKSPACE_ID } from "../houseWorkspace";
import { snapshotModels } from "../catalog";
import { directTextCostUsd } from "../openai-direct";
import { directVendorOf } from "../textRoute";

/**
 * MONEY. The visitor bar's spend on the ledger (owner, 17 Oct 2026: "Its usage goes in the ledger as house spend,
 * marked 'visitor'").
 *
 * Each paid call (the model replied, whether the screen showed the reply, held it, or the reply carried no answer; or
 * the call was sent and never answered, at an unknown cost) is written once through
 * the one ledger writer every engine call uses, `meter()` (lib/meter.ts), exactly as house spend is written today:
 *  - on the house workspace (lib/houseWorkspace.ts), which is never billed in credits: written outside any request's
 *    tenant, so `paidByPlatformEngine` reads it as not paid by the platform for a customer, and `unbilled` as well, so
 *    `billed_credits` is 0 (NULL when the cost cannot be priced: the meter leaves an unknown bill unknown) and no
 *    balance moves; the meter's own zero-credit receipt row (meter_credit_receipts) is written as for any house job;
 *  - kind `text`, the engine the call took (the bar takes only direct doors, so its text ledger is the model's vendor:
 *    `anthropic` or `google`), the model, status `succeeded`;
 *  - `engine_cost_usd`: the provider's usage at the checked-in price snapshot (`directTextCostUsd`, as the direct text
 *    paths price it), or null when there is no usage or it cannot be priced (the row is still written, so the call is
 *    counted);
 *  - marked `visitor`: `created_by = 'visitor'`, and the row's id starts `visitor_`.
 * No customer workspace is ever named, no credit is ever charged, and no new money record exists beside the meter.
 *
 * A failure to record never fails the answer: the visitor already has it, and the meter logs the miss itself (its own
 * line names the row id, never the question). The route logs whether it was recorded. The meter writes through the
 * platform's recovery-fenced client (lib/platform.ts), so on a remote database a write whose connection drops can
 * leave an "uncertain" recovery record, as any meter write can.
 */

export const VISITOR_MARK = "visitor";

export type VisitorSpend = { id: string; model: string; usage: Record<string, unknown> | null };
type Writer = typeof meter;

/** The cost of one answer, in the vendor's dollars at the price snapshot; null when it cannot be priced. */
export function visitorCostUsd(model: string, usage: Record<string, unknown> | null): number | null {
  if (!usage) return null;
  const priced = snapshotModels().find((entry) => entry.id === model);
  return priced ? directTextCostUsd(priced, usage) : null;
}

/** Writes one answer's spend as house spend marked "visitor". Resolves to whether it was written; never throws. */
export async function recordVisitorSpend(spend: VisitorSpend, write: Writer = meter): Promise<{ recorded: boolean; costUsd: number | null }> {
  let costUsd: number | null = null;
  try {
    costUsd = visitorCostUsd(spend.model, spend.usage);
    /* The bar only ever takes a direct door (lib/visitor/bar.ts), so its ledger is the model's vendor. */
    const engine = directVendorOf(spend.model);
    if (!engine) return { recorded: false, costUsd };
    /* Critical, so a write that fails says so (meter() logs it and throws) instead of passing quietly; caught below. */
    await write({
      id: `visitor_${spend.id}`,
      workspaceId: HOUSE_WORKSPACE_ID,
      kind: "text",
      engine,
      model: spend.model,
      status: "succeeded",
      engineCostUsd: costUsd,
      createdBy: VISITOR_MARK,
      unbilled: true,
    }, { critical: true });
    return { recorded: true, costUsd };
  } catch {
    return { recorded: false, costUsd };
  }
}
