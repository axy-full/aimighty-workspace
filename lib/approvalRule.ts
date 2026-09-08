/**
 * The cost approval rule (brief 2.2): a workspace setting that says who may
 * press. "anyone" is no rule; "cap" means a shot may take so many credits
 * before a member needs an admin to press; "producer" means a producer signs
 * off on every take — which is the review trail, not a gate. Pure: the
 * route enforces it, the composer says it before the press.
 */
export type ApprovalRule = "anyone" | "cap" | "producer";

export function cleanRule(v: unknown): ApprovalRule {
  return v === "cap" || v === "producer" ? v : "anyone";
}

/** The per-shot cap in credits: a whole number from 1 up, 50 when unset or nonsense. */
export function cleanShotCap(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : 50;
}

/** What the composer says under the price, or nothing when anyone may press. */
export function ruleLine(rule: ApprovalRule, cap: number, credits: (n: number) => string): string {
  if (rule === "cap") return `Over ${credits(cap)} on a shot needs an admin.`;
  if (rule === "producer") return "A producer signs off on every take.";
  return "";
}

/** Whether this press is blocked, and the sentence that says why. */
export function shotCapVerdict(o: {
  rule: ApprovalRule; isAdmin: boolean; cap: number;
  shotCredits: number; takeCredits: number; code: string;
}, credits: (n: number) => string): { blocked: boolean; line: string } {
  if (o.rule !== "cap" || o.isAdmin) return { blocked: false, line: "" };
  const after = o.shotCredits + o.takeCredits;
  if (after <= o.cap) return { blocked: false, line: "" };
  return {
    blocked: true,
    line: `${o.code} is at ${credits(o.shotCredits)}; this take makes it ${credits(after)}, over the ${credits(o.cap)} a shot may take. An admin has to press this one.`,
  };
}
