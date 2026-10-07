"use client";
import { useSession } from "@/lib/session";
import { cleanRule, cleanShotCap, jobApprovalLineCredits, type ApprovalRule } from "@/lib/approvalRule";
import { creditRate, creditsText } from "@/lib/shell/price-words";
import { useRead } from "../use-settings";
import { cleanBudget } from "@/lib/budgetPause";
import { spendingLines, type SpendingLines, type SpendingRules } from "./spending-words";

export type { SpendingRules } from "./spending-words";

/**
 * The workspace's spending rules as the code holds them, for every screen that shows them: Settings ›
 * Spending rules (where they change), the control room's Approvals and the phone (DECISIONS 1).
 *
 *  - Who may approve: the cost approval rule and its per-shot cap (GET /api/settings; lib/approvalRule.ts).
 *    Limits are by role: members up to the cap, an admin above it.
 *  - The platform line: JOB_APPROVAL_LINE_USD at the server's credit rate. A job above it never runs without a tap.
 *  - Spend without asking: "ask". Ask or Auto is picked per Board run today (Ask by default; lib/workbench/
 *    rig-agent-limits.ts); in Auto a draft at or under the per-job line runs without a tap. The per-job line is
 *    RIG_AGENT_JOB_CEILING_CREDITS, which is null, so it is the platform line (tests/unit/demo-s09-settings.spec.ts
 *    pins that). Making it a workspace setting is money work for the owner, later.
 *
 * Read only: nothing here writes. `null` figures mean "not known yet", never zero.
 */
export function useSpendingRules(): SpendingRules & SpendingLines & { budget: number | null; error: string | null; retry: () => void } {
  const session = useSession();
  const { data, error, read } = useRead<{ settings: Record<string, string>; defaults: Record<string, string> }>("/api/settings");
  const value = (key: string) => data?.settings[key] ?? data?.defaults[key];
  const rate = creditRate(session.rates.creditUsd);
  const line = rate === null ? null : jobApprovalLineCredits(rate);
  const rule: ApprovalRule | null = data ? cleanRule(value("approvalRule")) : null;
  const warn = Number(value("capWarnPct"));
  const rules: SpendingRules = {
    loaded: Boolean(data),
    rule,
    shotCap: data ? cleanShotCap(value("shotCapCredits")) : null,
    platformLine: line,
    mode: "ask",
    perJobLine: line,
    capWarnPct: data && Number.isFinite(warn) ? warn : null,
    atCap: data ? (value("atCap") === "stop" || value("atCap") === "warn" ? (value("atCap") as "stop" | "warn") : "producer") : null,
    canChange: session.role === "admin" || session.role === "owner",
  };
  /* The budget per production (lib/caps.ts projectCap): none when blank. */
  const budget = data ? cleanBudget(value("productionBudgetCredits")) : null;
  return { ...rules, ...spendingLines(rules, creditsText), budget, error, retry: () => void read() };
}
