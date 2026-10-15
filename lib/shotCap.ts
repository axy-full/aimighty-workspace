import { getSetting } from "./settings";
import { billCredits, billCreditsWith } from "./creditTerms";
import { cleanRule, cleanShotCap, jobApprovalLineCredits, jobLineVerdict, shotCapVerdict } from "./approvalRule";
import { creditUsd } from "./creditTerms";
import { creditsApply } from "./credits";
import { currentTenant } from "./tenant";
import { paidByPlatform } from "./platformSpend";
import { isHouseWorkspace } from "./houseWorkspace";
import type { EngineVendor } from "./vendorKeys";
import { isAgentId } from "./security/people-only";
import { NO_BATCH, takesToCome, type BatchRef, type BatchTally } from "./batchLine";
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
 * Guardrail 4 before a job is parked, quoted or sent (lib/approvalRule.ts › jobLineVerdict): a job above the approval line needs an
 * admin's own tap, whatever the rule and shot; a token, an MCP client or an agent is refused outright. The reservation
 * (lib/generationRequests.ts) judges the same job again under its write lock and is the authority; this stops it earlier, so a member's
 * over-line take is told so at the press or the quote and is never parked as held or left as a failed take.
 *
 * Judged: work the platform pays for (`paidByPlatform` for the door's own vendor key), and **the house workspace, at cost**: its job is
 * the engine's dollars counted in credits at no margin (the unit `quotedCredits` approves it in, lib/credits.ts), against the same line,
 * worded without a figure. Work on no credit of the platform's and not the house (an own-key workspace, if one ever exists) is not judged.
 * Null when nothing stops it.
 */
export function jobLineGateAt(o: { credits: number; usd: number; band?: number; key: EngineVendor; isAdmin: boolean; machine: boolean; batch?: { ref?: BatchRef; tally: BatchTally } }): string | null {
  const ws = currentTenant()?.workspace;
  const house = isHouseWorkspace(ws);
  if (!house && !paidByPlatform(o.key)) return null;
  const band = Number.isInteger(o.band) && o.band! > 1 ? o.band! : 1;
  /* One press is one job: the takes of its batch already reserved, plus this one and those to come, each at its hold. */
  const tally = o.batch?.tally ?? NO_BATCH;
  const more = takesToCome(o.batch?.ref, tally);
  const credits = house ? billCreditsWith(tally.usd + o.usd * band * more, 1, creditUsd()) : tally.credits + o.credits * band * more;
  const v = jobLineVerdict({ credits, lineCredits: jobApprovalLineCredits(creditUsd()), isAdmin: o.isAdmin, machine: o.machine, figures: creditsApply(ws) });
  return v.blocked ? v.line : null;
}

/** The same, for a take's engine cost: its price in credits (a take that holds its ceiling counts at its band). */
export function jobLineGate(o: { takeUsd: number; modelId: string; band?: number; key: EngineVendor; isAdmin: boolean; machine: boolean; batch?: { ref?: BatchRef; tally: BatchTally } }): string | null {
  return jobLineGateAt({ credits: billCredits(o.takeUsd, o.modelId), usd: o.takeUsd, band: o.band, key: o.key, isAdmin: o.isAdmin, machine: o.machine, batch: o.batch });
}

/**
 * The same, for a quote or admission with no take to price: the person or machine asking is the admission's actor when it names one
 * (an admin's own session is a tap; a token, an MCP client or an agent identity is a machine), else the request's tenant. `key` is the door's own vendor key.
 */
export function jobLineNow(o: { credits: number; usd: number; key: EngineVendor; actor?: { user: { id: string; role: string }; token?: unknown }; /** The step was approved by Atomik's Auto, not by a person: a machine. */ auto?: boolean }): string | null {
  const store = currentTenant();
  const user = o.actor?.user ?? store?.user;
  const token = o.actor ? o.actor.token : store?.token;
  return jobLineGateAt({ credits: o.credits, usd: o.usd, key: o.key, isAdmin: user?.role === "admin" && token == null, machine: o.auto === true || token != null || isAgentId(user?.id) });
}
