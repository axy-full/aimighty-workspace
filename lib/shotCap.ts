import { db, ready } from "./db";
import { getSetting } from "./settings";
import { billedCreditsSum } from "./creditSql";
import { billCredits } from "./creditTerms";
import { cleanRule, cleanShotCap, shotCapVerdict } from "./approvalRule";

/** What a shot has been billed so far, in credits, over its live takes. */
export async function shotCreditsSoFar(shotId: string): Promise<number> {
  await ready();
  const rs = await db().execute({ sql: `SELECT ${billedCreditsSum("g")} AS credits FROM generations g WHERE g.shot_id = ? AND g.deleted = 0`, args: [shotId] });
  return Number((rs.rows[0] as unknown as { credits?: number })?.credits ?? 0);
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
