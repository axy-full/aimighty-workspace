"use client";
/*
 * LOCAL STUB of stream 9's useSpendingRules() (decision 1). Never committed by
 * stream 8; replaced by stream 9's file when it lands. Read only.
 */
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { cleanRule, cleanShotCap, jobApprovalLineCredits, type ApprovalRule } from "@/lib/approvalRule";

export type SpendingRules = {
  status: "loading" | "ready" | "error";
  rule: ApprovalRule;
  cap: number;
  /** Any job over this needs a person, even under Auto (credits). */
  platformLine: number;
  /** Spend without asking: Ask, the default; picked per board run today. */
  mode: "ask";
  /** In Auto, a draft at or under this runs without a tap (credits). */
  jobLine: number;
};

export function useSpendingRules(): SpendingRules {
  const session = useSession();
  const settings = useApi<{ settings: Record<string, string> }>("/api/settings", 0, session.requestScope);
  const creditUsd = session.rates.creditUsd ?? 0;
  const line = jobApprovalLineCredits(creditUsd);
  return {
    status: settings.error ? "error" : settings.data ? "ready" : "loading",
    rule: cleanRule(settings.data?.settings?.approvalRule),
    cap: cleanShotCap(settings.data?.settings?.shotCapCredits),
    platformLine: line,
    mode: "ask",
    jobLine: line,
  };
}
