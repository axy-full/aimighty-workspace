import { FREE, creditsText, exact, priceSum, priceWords } from "@/lib/shell/price-words";
import { fromTenths, toTenths } from "@/lib/runLimit";
import type { BoardCard } from "@/lib/board/types";
import { STUDIO_GROUP } from "@/lib/board/regions";
import { PLAN_CEILING_MULTIPLE, planTitle, totalLineOf, type PlanModel, type PlanStep } from "./model";
import type { PlanData } from "./derive";

/*
 * The plan card on the explore-only sample production (lead decisions 12 and 38): nothing was ever asked of Atomik
 * there, so there is no run, and none is made up. The sample's own recorded prices (stream 12) come in as steps and
 * this builds the same card model the live plan uses at its gate: the shots with their prices, what they come to,
 * the most the plan may spend with fixes (2 × that), and the price as the button. Every control is disabled with the
 * sample's line. Pure.
 */
export type SampleStep = { title: string; meta: string; credits: number; kind?: "take" | "still" };

export function samplePlanModel(steps: readonly SampleStep[], line: string): PlanModel {
  const rows: PlanStep[] = steps.map((s, i) => ({
    seq: i + 1, kind: s.kind ?? "take", title: s.title, meta: s.meta, price: exact(s.credits), source: "run", unavailable: null, needsAdmin: false, asksAlone: null,
    state: "next", status: "Planned", reason: null, canRender: false, fingerprint: null,
  }));
  const total = rows.length ? priceSum(rows.map((r) => r.price)) : FREE;
  const takes = rows.filter((r) => r.kind === "take");
  const credits = total && "credits" in total ? total.credits : 0;
  /* The most the plan may spend, fixes included: 2 × its total (93 → 186). */
  const ceiling = rows.length ? fromTenths(PLAN_CEILING_MULTIPLE * toTenths(credits)) : null;
  const shots = planTitle(rows.length, "proposal");
  return {
    runId: "sample", phase: "proposal", title: ceiling != null && total ? `${shots} · ${priceWords(total)} · at most ${creditsText(ceiling)}` : shots, steps: rows, total,
    ceiling, used: null,
    balance: null,
    totalLine: totalLineOf(total, takes.length),
    thinking: null, modeLine: null, ruleLine: null, adminLine: "Needs an admin",
    primary: rows.length && total
      ? { kind: "plan", label: `Approve · ${priceWords(total)}`, price: total, fingerprint: "sample", blocked: line }
      : { kind: "approve", label: "Approve", price: null, raiseTo: null, fingerprint: "sample", blocked: line },
    note: null, mine: false,
  };
}

/** The plan card for the sample, in the Storyboard group's open slot. `open`: its steps are unfolded. */
export function samplePlanCard(model: PlanModel, open = false): BoardCard<PlanData> {
  return {
    id: "plan:sample", kind: "plan", region: "storyboard", group: STUDIO_GROUP.storyboard, order: 10_000, state: "needs",
    data: { run: null, sample: model, open },
  };
}
