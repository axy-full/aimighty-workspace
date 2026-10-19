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

/*
 * Retired, 20 October 2026: the platform's per-job line (SOW §7A guardrail 4, US$20 = 200 cr at a credit's US$0.10) is gone.
 * The owner's words: "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the product. Every job is
 * approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused."
 * No job is refused, parked or sent to an admin because of its size alone. What stays here is the workspace's OWN rule:
 * with "cap per shot", a member's take that carries a shot past the workspace's cap needs an admin (shotCapVerdict below);
 * the workspace's setting alone decides whether that fires.
 */

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
