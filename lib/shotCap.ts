import { getSetting } from "./settings";
import { billCredits } from "./creditTerms";
import { cleanRule, cleanShotCap, shotCapVerdict } from "./approvalRule";
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
export async function shotCapGate(o: { shotId: string; code: string; takeUsd: number; modelId: string; isAdmin: boolean }): Promise<string | null> {
  const rule = cleanRule(await getSetting("approvalRule"));
  if (rule !== "cap" || o.isAdmin) return null;
  const cap = cleanShotCap(await getSetting("shotCapCredits"));
  const shotCredits = await shotCreditsSoFar(o.shotId);
  const takeCredits = billCredits(o.takeUsd, o.modelId);
  const v = shotCapVerdict({ rule, isAdmin: o.isAdmin, cap, shotCredits, takeCredits, code: o.code }, (n) => `${n} cr`);
  return v.blocked ? v.line : null;
}
