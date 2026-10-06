/**
 * Settings › Spending rules › Budget and cap, in words (design Gaps B: "?view=workspace&ws=rules&edit=rules"). Pure, so
 * the unit specs hold each line to the code:
 *  - the budget per production is `productionBudgetCredits` (lib/caps.ts projectCap: a production with no cap of its
 *    own follows it), and the pause asks at `capWarnPct` of it (lib/caps.ts budgetPause, rounded down);
 *  - "Before an admin" is the cost approval rule's per-shot cap (lib/approvalRule.ts: rule "cap", 50 cr by default).
 *    Typing a figure there turns the rule to "cap"; clearing it turns it to "anyone". A "producer" rule is changed
 *    under Who may approve, not here.
 * Limits are by role (owner, admin, member), never by person; only an admin changes them, and only a person.
 */
import type { ApprovalRule } from "@/lib/approvalRule";
import { budgetPause } from "@/lib/budgetPause";

export type BudgetRules = { budget: number | null; warnPct: number | null; rule: ApprovalRule | null; shotCap: number | null };

/** "the 80 % pause asks at 320 cr", or what no budget means. */
export function budgetLine(r: Pick<BudgetRules, "budget" | "warnPct">, cr: (n: number) => string): string {
  const pause = r.budget == null ? null : budgetPause({ cap: r.budget, spent: 0, needs: 0, warnPct: r.warnPct ?? 80 });
  return pause ? `the ${pause.pct} % pause asks at ${cr(pause.pauseAt)}` : "none · a production follows its own cap, if it has one";
}

/** The help under the budget field. */
export function budgetHelp(r: Pick<BudgetRules, "budget" | "warnPct">, cr: (n: number) => string): string {
  const pause = r.budget == null ? null : budgetPause({ cap: r.budget, spent: 0, needs: 0, warnPct: r.warnPct ?? 80 });
  if (!pause) return "No budget: each production follows its own cap, if it has one.";
  return `Particl pauses at ${pause.pct} % (${cr(pause.pauseAt)}) and asks whether to continue.`;
}

/** The "Before an admin" row: its value and line. */
export function capRow(r: Pick<BudgetRules, "rule" | "shotCap">, cr: (n: number) => string): { value: string; line: string } {
  if (r.rule === "cap" && r.shotCap != null) return { value: cr(r.shotCap), line: "per shot" };
  if (r.rule === "producer") return { value: "producer", line: "a producer signs off on every take" };
  return { value: "off", line: "anyone on the team may approve a step" };
}

/** The help under the cap field. */
export function capHelp(r: Pick<BudgetRules, "rule" | "shotCap">): string {
  if (r.rule === "producer") return "The rule is “a producer signs off on every take”. Change it under Who may approve.";
  if (r.rule === "cap") return "A step over this needs an admin’s approval.";
  return "Off: anyone on the team may approve a step. Type a figure to need an admin above it.";
}

/** A field's text as a person types it: digits only, at most seven. */
export const digits = (raw: string) => raw.replace(/[^0-9]/g, "").slice(0, 7);

/**
 * The settings one field's text saves (PATCH /api/settings), or a problem. Empty clears the budget, or turns the
 * per-shot rule off ("anyone"); a figure is a whole number of credits from 1.
 */
export function fieldPatch(field: "budget" | "cap", text: string, rule: ApprovalRule | null): { patch: Record<string, string> } | { problem: string } {
  const t = text.trim();
  const n = Number(t);
  const ok = /^\d{1,7}$/.test(t) && n >= 1 && n <= 1_000_000;
  if (field === "budget") {
    if (t === "") return { patch: { productionBudgetCredits: "" } };
    return ok ? { patch: { productionBudgetCredits: String(n) } } : { problem: "The budget is a whole number of credits, 1 or more, or empty for none." };
  }
  if (rule === "producer") return { problem: "Change the producer rule under Who may approve first." };
  if (t === "") return { patch: { approvalRule: "anyone" } };
  return ok ? { patch: { approvalRule: "cap", shotCapCredits: String(n) } } : { problem: "The cap is a whole number of credits, 1 or more, or empty for none." };
}
