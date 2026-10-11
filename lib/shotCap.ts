import { getSetting } from "./settings";
import { billCredits } from "./creditTerms";
import { cleanRule, cleanShotCap, jobApprovalLineCredits, jobLineVerdict, shotCapVerdict } from "./approvalRule";
import { creditUsd } from "./creditTerms";
import { creditsApply } from "./credits";
import { currentTenant } from "./tenant";
import { spentBy } from "./caps";

/**
 * What a shot has been billed so far, in credits: every take, hidden ones
 * included, as the reservation gate counts it (spentBy in lib/caps.ts).
 */
export async function shotCreditsSoFar(shotId: string): Promise<number> {
  return (await spentBy("shot_id", [shotId])).get(shotId)?.credits ?? 0;
}

/**
 * The cost approval rule at the press (brief 2.2): with "cap per shot", a
 * member's take that would carry the shot past the cap is refused with the
 * sentence that says so; an admin's goes through. Null when nothing stops it.
 */
export async function shotCapGate(o: { shotId: string; code: string; takeUsd: number; modelId: string; isAdmin: boolean; band?: number }): Promise<string | null> {
  const rule = cleanRule(await getSetting("approvalRule"));
  if (rule !== "cap" || o.isAdmin) return null;
  const cap = cleanShotCap(await getSetting("shotCapCredits"));
  const shotCredits = await shotCreditsSoFar(o.shotId);
  /* A take that holds its ceiling (Cinema Studio, lib/cinemaHold.ts) counts at its hold, not its estimate. */
  const takeCredits = billCredits(o.takeUsd, o.modelId) * (Number.isInteger(o.band) && o.band! > 1 ? o.band! : 1);
  const v = shotCapVerdict({ rule, isAdmin: o.isAdmin, cap, shotCredits, takeCredits, code: o.code }, (n) => `${n} cr`);
  return v.blocked ? v.line : null;
}

/**
 * Guardrail 4 before a take is parked or sent (lib/approvalRule.ts › jobLineVerdict): a job above the approval line needs an admin's own
 * tap, whatever the rule and shot; a token, an MCP client or an agent is refused outright. The reservation (lib/generationRequests.ts)
 * judges the same job again under its write lock and is the authority; this stops it earlier, so a member's over-line take is told so at the
 * press and is never parked as held. Null when nothing stops it.
 */
export function jobLineGate(o: { takeUsd: number; modelId: string; band?: number; isAdmin: boolean; machine: boolean }): string | null {
  const credits = billCredits(o.takeUsd, o.modelId) * (Number.isInteger(o.band) && o.band! > 1 ? o.band! : 1);
  const v = jobLineVerdict({ credits, lineCredits: jobApprovalLineCredits(creditUsd()), isAdmin: o.isAdmin, machine: o.machine, figures: creditsApply(currentTenant()?.workspace) });
  return v.blocked ? v.line : null;
}
