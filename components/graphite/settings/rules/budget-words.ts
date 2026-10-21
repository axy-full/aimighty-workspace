/**
 * Settings › Spending rules › Budget and cap, in words (design Gaps B: "?view=workspace&ws=rules&edit=rules"). Pure, so
 * the unit specs hold each line to the code:
 *  - the budget per production is `productionBudgetCredits` (lib/caps.ts projectCap: a production with no cap of its
 *    own follows it), and the producer is warned at `capWarnPct` of it (lib/caps.ts checkCap; budgetPause, rounded down). There is no Auto since
 *    20 Oct 2026: every render waits for a person, and an approved plan or a person's own render past that share goes on to the budget;
 *    House workspaces, not billed in credits, have no budget (`notEnforced`).
 *  - There is no "Before an admin" any more: the cost approval rule and its per-shot cap were retired on 21 Oct 2026 (owner:
 *    "every member approves their own spend with their own tap on the quote").
 * Limits are by role (owner, admin, member), never by person; only an admin changes them, and only a person.
 */
import { budgetPause } from "@/lib/budgetPause";

export type BudgetRules = { budget: number | null; warnPct: number | null };

/** "warns at 320 cr (80 %)", or what no budget means. */
export function budgetLine(r: Pick<BudgetRules, "budget" | "warnPct">, cr: (n: number) => string): string {
  const pause = r.budget == null ? null : budgetPause({ cap: r.budget, spent: 0, needs: 0, warnPct: r.warnPct ?? 80 });
  return pause ? `warns at ${cr(pause.pauseAt)} (${pause.pct} %)` : "none · a production follows its own cap, if it has one";
}

/** The help under the budget field. */
export function budgetHelp(r: Pick<BudgetRules, "budget" | "warnPct">, cr: (n: number) => string): string {
  const pause = r.budget == null ? null : budgetPause({ cap: r.budget, spent: 0, needs: 0, warnPct: r.warnPct ?? 80 });
  if (!pause) return "No budget: each production follows its own cap, if it has one.";
  return `Warns at ${pause.pct} % (${cr(pause.pauseAt)}); every render still waits for a person, and an approved plan runs on to the budget.`;
}

/** A field's text as a person types it: digits only, at most seven. */
export const digits = (raw: string) => raw.replace(/[^0-9]/g, "").slice(0, 7);

/**
 * The setting the budget field's text saves (PATCH /api/settings), or a problem. Empty clears the budget; a figure is a
 * whole number of credits from 1.
 */
export function budgetPatch(text: string): { patch: Record<string, string> } | { problem: string } {
  const t = text.trim();
  const n = Number(t);
  const ok = /^\d{1,7}$/.test(t) && n >= 1 && n <= 1_000_000;
  if (t === "") return { patch: { productionBudgetCredits: "" } };
  return ok ? { patch: { productionBudgetCredits: String(n) } } : { problem: "The budget is a whole number of credits, 1 or more, or empty for none." };
}

/** What the budget row says in a workspace not billed in credits, where nothing enforces it (lib/caps.ts projectCap). */
export const NOT_ENFORCED = "This workspace is not billed in credits: no budget per production applies here.";
