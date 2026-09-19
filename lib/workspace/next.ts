import type { AppState } from "./types";
import type { PlanSummary } from "./plan-source";

/**
 * The Library footer's one derived sentence (04, "Derived values"):
 * waiting on approval → running step → rendering → ready shots → plan title.
 * Never fixed copy.
 */
export function nextSentence(
  state: Pick<AppState, "page" | "run" | "gen" | "lists">,
  plan: PlanSummary | null,
): string {
  const run = state.run && state.run.page === state.page ? state.run : null;
  if (run?.status === "waiting")
    return plan?.gatePrice ? `Waiting on your approval — ${plan.gatePrice}.` : "Waiting on your approval.";
  if (run?.status === "running") {
    const step = plan?.steps?.[Math.min(run.i, plan.steps.length - 1)];
    return step ? `${step}…` : plan ? `Running ${plan.title}…` : "Running…";
  }
  if (state.gen) return `Rendering ${state.gen.name}. Nothing else is blocked.`;
  if (state.page === "rig" && state.lists.shots) {
    const ready = state.lists.shots.filter((s) => s.status === "ready" || s.status === "queued");
    if (ready.length)
      return `${ready.length.toLocaleString("en-US")} ${ready.length === 1 ? "shot is" : "shots are"} ready to render. Start with ${ready[0].name}.`;
  }
  if (plan) return plan.price ? `${plan.title} — ${plan.price.toLowerCase()}.` : `${plan.title}.`;
  return "Nothing waiting on this page.";
}

/** The agent's dot colour, shared by the Atomik button, NEXT and the run chip. */
export function agentDot(state: Pick<AppState, "page" | "run" | "gen">): string {
  const run = state.run && state.run.page === state.page ? state.run : null;
  if (run?.status === "waiting") return "var(--pxw-amber)";
  if (run?.status === "running" || state.gen) return "var(--pxw-blue)";
  return "var(--pxw-atomik-gold)";
}
