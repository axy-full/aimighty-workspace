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

/**
 * SOW §7A guardrail 4, the platform's approval line: any single job estimated above this price needs the
 * workspace's cost approval rule, whatever the workspace's own setting. It is a price, so in credits it
 * follows the price of a credit (the SOW's "200 cr" is this line at a credit's US$0.10), and the same
 * line reads as fewer credits when a credit costs more.
 * Its single source: change the line here. It is enforced at the press (jobLineVerdict below): in the reservation
 * (lib/generationRequests.ts), in admission and the audio, dubbing and text quotes (lib/shotCap.ts), and in the quote
 * verdict (lib/quote.ts). Atomik's Rig runs also use it as the most one Auto job may cost without asking
 * (lib/workbench/rig-agent-limits.ts); an Auto step is a machine here and never starts a job over it.
 */
export const JOB_APPROVAL_LINE_USD = 20;

/** Guardrail 4 in credits at a price of a credit, in whole tenths (rounded down: a job exactly at the line is not above it). */
export function jobApprovalLineCredits(perCredit: number): number {
  if (!(Number.isFinite(perCredit) && perCredit > 0)) return 0;
  return Math.floor((JOB_APPROVAL_LINE_USD / perCredit) * 10 + 1e-9) / 10;
}

/**
 * Guardrail 4 at the press (SOW §7A): a single job priced above the platform's approval line needs an admin's own tap, whatever
 * the workspace's approval rule, and whatever shot it is for. Judged on the job's price in credits (`credits`: a take at its hold,
 * a batch's takes multiplied before they are compared where a quote stands for several), against `lineCredits`, the line at the
 * workspace's price of a credit (`jobApprovalLineCredits`). Exactly at the line is not above it.
 *
 * Who clears it: an admin pressing it themselves (`isAdmin`, and a person). A member is refused with the sentence that says an admin
 * must start it. An API token, an MCP client and Atomik (`machine`) are refused outright, admin or not: they prepare a job over the
 * line, and an admin starts it (rule 14: approving spend is a person's alone). `figures` says whether the sentence may carry
 * credits (a credit workspace); the house, which pays in dollars at cost, is never worded in credits.
 */
export const JOB_LINE_STATUS = 403;
export function jobLineVerdict(o: { credits: number; lineCredits: number; isAdmin: boolean; machine: boolean; figures?: boolean },
  credits: (n: number) => string = (n) => `${Math.round(n).toLocaleString("en-US")} cr`): { blocked: boolean; line: string } {
  if (!(o.lineCredits > 0) || !(o.credits > o.lineCredits + 1e-9)) return { blocked: false, line: "" };
  const figures = o.figures !== false;
  if (o.machine)
    return { blocked: true, line: figures
      ? `A job over ${credits(o.lineCredits)} needs an admin's own tap. Atomik, an MCP client and API tokens can prepare it, never start it.`
      : "A job this size needs an admin's own tap. Atomik, an MCP client and API tokens can prepare it, never start it." };
  if (o.isAdmin) return { blocked: false, line: "" };
  return { blocked: true, line: figures
    ? `This job is ${credits(o.credits)}, over the ${credits(o.lineCredits)} that needs an admin. An admin has to start it.`
    : "This job is over the size that needs an admin. An admin has to start it." };
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
