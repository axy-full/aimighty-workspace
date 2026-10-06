/**
 * The spending rules in words (pure, so the unit specs hold each line to the code). Copy says what the
 * code does (DECISIONS 2, 9, 10): limits by role, never a named person; at the warning share (80 % unless changed) an Auto run asks again (lib/caps.ts budgetAsk); Ask unless a
 * person picks Auto for one Board run.
 */
import type { ApprovalRule } from "@/lib/approvalRule";

export type SpendingRules = {
  loaded: boolean;
  rule: ApprovalRule | null;
  /** Credits a shot may take before a member needs an admin (the "cap" rule). */
  shotCap: number | null;
  /** Guardrail 4 in credits: a job above it never runs without a person's tap. */
  platformLine: number | null;
  /** Spend without asking. Always "ask" until the owner makes it a workspace setting. */
  mode: "ask";
  /** In Auto (one Board run at a time), a draft at or under this runs without a tap. */
  perJobLine: number | null;
  capWarnPct: number | null;
  atCap: "producer" | "stop" | "warn" | null;
  /** Whether this person may change them (an admin or the owner); Atomik and outside agents never may. */
  canChange: boolean;
};

export type SpendingLines = {
  /** "Members up to 50 cr a shot; an admin above it." */
  ruleLine: string | null;
  /** "Any job over 200 cr needs a person's approval, even under Auto." */
  platformLineText: string | null;
  /** "Every paid step waits for a person." */
  modeLine: string;
  /** "Auto is picked per Board run, for drafts at or under 200 cr." */
  autoLine: string | null;
  /** "Ask at 80% of a production’s budget · at the cap an admin unlocks it" */
  budgetLine: string | null;
};

const AT_CAP: Record<"producer" | "stop" | "warn", string> = {
  producer: "at the cap an admin unlocks it",
  stop: "rendering stops at the cap",
  warn: "the cap only warns",
};

export function spendingLines(r: SpendingRules, cr: (n: number) => string): SpendingLines {
  return {
    ruleLine: r.rule === null ? null
      : r.rule === "cap" ? (r.shotCap === null ? null : `Members up to ${cr(r.shotCap)} a shot; an admin above it.`)
      : r.rule === "producer" ? "A producer signs off on every take."
      : "Members render freely.",
    platformLineText: r.platformLine === null ? null : `Any job over ${cr(r.platformLine)} needs a person’s approval, even under Auto.`,
    modeLine: "Every paid step waits for a person.",
    autoLine: r.perJobLine === null ? null : `Auto is picked per Board run, for drafts at or under ${cr(r.perJobLine)}.`,
    budgetLine: r.capWarnPct === null || r.atCap === null ? null : `Ask at ${r.capWarnPct}% of a production’s budget · ${AT_CAP[r.atCap]}`,
  };
}

/** The value the Rule row shows: the cap in credits, or the rule's own word. */
export function ruleValue(r: Pick<SpendingRules, "rule" | "shotCap">, cr: (n: number) => string): string {
  return r.rule === "cap" ? (r.shotCap === null ? "cap" : cr(r.shotCap)) : r.rule ?? "—";
}

/** A cap as a person types it: a whole number of credits, 1 or more (0 too when `zero`), else null. */
export function capInput(raw: string, zero = false): number | null {
  const text = raw.trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  const n = Number(text);
  return n >= (zero ? 0 : 1) ? n : null;
}

/**
 * GET /api/projects, as a workspace billed in credits is answered (app/api/projects/route.ts): `capCredits` is the cap
 * the gate enforces (its own, else the workspace's budget per production), `capFrom` whose it is, `ownCapCredits` its own.
 */
export type ProductionBudget = {
  id: string; name: string; credits?: number; capCredits: number | null; capUnlocked?: boolean;
  capFrom?: "production" | "workspace" | null; ownCapCredits?: number | null;
};
/** Whether the gate can refuse this production at its cap now: an admin's Unlock is offered exactly then. */
export const atItsCap = (p: ProductionBudget) => p.capCredits != null && (p.credits ?? 0) >= p.capCredits;
/** "184 of 200 cr" and its sub-line: what the production has spent against its cap, whose cap it is, and where it stands. */
export function productionLine(p: ProductionBudget, cr: (n: number) => string): { value: string; sub: string } {
  const spent = p.credits ?? 0;
  if (p.capCredits == null) return { value: cr(spent), sub: "No cap · no budget per production is set" };
  const whose = p.capFrom === "workspace" ? "the workspace budget" : "its own cap";
  const state = p.capUnlocked ? `unlocked past ${whose} by an admin` : atItsCap(p) ? `at ${whose}` : `${cr(Math.max(0, p.capCredits - spent))} left of ${whose}`;
  return { value: `${spent.toLocaleString("en-US")} of ${cr(p.capCredits)}`, sub: state };
}
