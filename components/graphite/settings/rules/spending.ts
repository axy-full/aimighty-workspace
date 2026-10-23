"use client";
import { useSession } from "@/lib/session";
import { useRead } from "../use-settings";
import { cleanBudget } from "@/lib/budgetPause";
import { spendingLines, type SpendingLines, type SpendingRules } from "./spending-words";

export type { SpendingRules } from "./spending-words";

/**
 * The workspace's spending rules as the code holds them, for every screen that shows them: Settings ›
 * Spending rules (where they change), the control room's Approvals and the phone (DECISIONS 1).
 *
 *  - Who may approve: each person, their own spend. The cost approval rule and its per-shot cap were retired on
 *    21 Oct 2026 (owner: "every member approves their own spend with their own tap on the quote"); nothing reads them.
 *  - No platform per-job line: guardrail 4 was retired on 20 October 2026 (owner), so none is read or shown.
 *  - Spend without asking: "ask", always. There is no Auto (owner, 20 Oct 2026: "Auto goes: every job is approved on its
 *    quote"): every paid step waits for a person's approval, its own or its plan's one approval.
 *
 * Read only: nothing here writes. `null` figures mean "not known yet", never zero.
 */
export function useSpendingRules(): SpendingRules & SpendingLines & { budget: number | null; error: string | null; retry: () => void } {
  const session = useSession();
  const { data, error, read } = useRead<{ settings: Record<string, string>; defaults: Record<string, string> }>("/api/settings");
  const value = (key: string) => data?.settings[key] ?? data?.defaults[key];
  const warn = Number(value("capWarnPct"));
  const rules: SpendingRules = {
    loaded: Boolean(data),
    mode: "ask",
    capWarnPct: data && Number.isFinite(warn) ? warn : null,
    atCap: data ? (value("atCap") === "stop" || value("atCap") === "warn" ? (value("atCap") as "stop" | "warn") : "producer") : null,
    canChange: session.role === "admin" || session.role === "owner",
  };
  /* The budget per production (lib/caps.ts projectCap): none when blank. */
  const budget = data ? cleanBudget(value("productionBudgetCredits")) : null;
  return { ...rules, ...spendingLines(rules), budget, error, retry: () => void read() };
}
