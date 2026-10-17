import { freshSettings } from "./settings";
import { rigJobCeiling } from "./workbench/rig-agent-limits";
import { jobApprovalLineCredits } from "./approvalRule";
import { creditUsd } from "./creditTerms";
import type { SpendPolicy } from "./mcp";

/**
 * The workspace's spending setting as an outside agent's paid tool must read it (rule 14: "outside a plan, every paid step asks, unless the workspace
 * allows spending without asking"). Only an exact "auto" lets a call start anything, and only a draft at or under the per-job line (the Rig's line, and
 * never above guardrail 4: 200 cr at $0.10 a credit); anything else, an unreadable setting included, is Ask. Nothing here approves anything: the
 * approval is the workspace admin's standing choice, not the caller's. Read past the settings memo (a spend decision acts on the value now).
 */
export async function mcpSpendPolicy(): Promise<SpendPolicy> {
  try {
    const auto = (await freshSettings()).spendWithoutAsking === "auto";
    return { auto, lineCredits: Math.min(await rigJobCeiling(), jobApprovalLineCredits(creditUsd())) };
  } catch { return { auto: false, lineCredits: 0 }; }
}
