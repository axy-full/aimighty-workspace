import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { requireTenant, runInTenant } from "@/lib/tenant";
import { isPersonApprover, PEOPLE_ONLY, planApprovalOf } from "./plan-approval";
import { driveRigAgent, planRigAgentStep, rigAgentState, RigAgentError, type TickDeps } from "./rig-agent";
import { getRun, rigAgentReady } from "./rig-agent-store";
import type { RigAgentPaidStepView } from "./rig-agent-plan";
import { readDraft } from "./records";

/**
 * `plan_step`: the tool behind Agent mode's quick plan (rule 11). The button (`agent.planStep` on the board's route), Atomik and an outside agent over MCP all make the
 * same plan: the server's own plan for a board step from its quick answers (lib/workbench/rig-agent-chips.ts), priced by the server's quote.
 *
 * It PREPARES and PRICES only. It spends nothing and approves nothing: the plan waits on the board for the person who owns it, who approves it once in Particl
 * (`agent.approvePlan`, a signed-in session, people only). This is the tool's declaration (what it takes, what it costs, who may use it); the route
 * (app/api/board-agent/plan) calls `preparePlanStep`, and the MCP tool (lib/mcp.ts `plan_step`) calls the route.
 */
export const PLAN_STEP_TOOL = {
  id: "plan_step",
  kind: "app" as const,
  provider: null,
  needs: [] as string[],
  route: "/api/board-agent/plan",
  inputs: {
    boardId: "the board (its project id); it must have been opened once in Particl", step: "shots (the only step with a quick plan yet)",
    answers: "quality: draft or final; length: 3, 5, 8 or 10 seconds (optional: the board's own, else the defaults)", cards: "shot card ids to plan (optional: every shot not approved yet)",
    requestId: "optional: a retried call with it gets back the plan it made",
  },
  price: { quote: "the plan's own total, from the server's quote for each render" },
  who: "prepare: any token or session that may write; approve: the person who owns the board, in Particl" as const,
};

export type PlanStepInput = { boardId: unknown; step?: unknown; answers?: unknown; cards?: unknown; requestId?: unknown };
export type PlanStepSummary = {
  id: string; state: string; step: string; priced: boolean;
  /** The plan's total at the server's prices, and the most it can come to with fixes; absent until every render is priced. */
  total: number | null; ceiling: number | null; approximate: boolean;
  /** The shots in the plan, by title. One price for the plan (`total`); no price per shot. */
  shots: string[];
  /** Renders that ask on their own (over the per-job line, or for an admin). */
  asks: number;
  /** Why it is not priced yet, in fixed words with no engine's name ("2 shots can't be priced yet; open the board."); null once priced. */
  reason: string | null;
  answers: { quality: string; length: number } | null;
  /** It replaced an earlier plan a tool made that was still waiting; never one a person made. */
  replaced: boolean;
  needs: "A person approves this plan in Particl. Nothing is spent until they do.";
};

const ID = /^[a-zA-Z0-9-]{1,100}$/;

/**
 * Why a plan has no price yet, in fixed words (owner, 16 Oct: no engine's name in any reply). A render's own pause reason can be a pricing refusal word for
 * word, naming the engine; this reply never carries it. The board shows what each shot needs.
 */
export function unpricedWords(takes: readonly Pick<RigAgentPaidStepView, "state" | "quote" | "pause" | "fixOf">[]): string {
  const open = takes.filter((p) => p.fixOf == null && (p.state === "next" || p.state === "waiting" || p.state === "paused"));
  /* Can't be priced: a render the run tried to price and paused. One merely not reached yet (next) is still being priced. */
  const unpriced = open.filter((p) => p.state === "paused" && p.quote == null && p.pause !== "admin").length;
  if (unpriced) return `${unpriced} ${unpriced === 1 ? "shot" : "shots"} can't be priced yet; open the board.`;
  if (open.some((p) => p.state === "next")) return "The plan is still being priced; open the board.";
  return open.length ? "Every shot here asks on its own; open the board." : "Nothing in this plan is waiting to render; open the board.";
}
const REQUEST = /^[A-Za-z0-9._:-]{1,120}$/;

/** Makes the plan for a person (or for a token acting as them), prices it, and says what it came to. Never approves, never sends, never reserves. */
export async function preparePlanStep(userId: string, input: PlanStepInput, deps: TickDeps & { budgetMs?: number } = {}): Promise<PlanStepSummary> {
  /* People only, before anything is read: an agent identity is refused as one, not as a board it cannot see. */
  if (!isPersonApprover(userId)) throw new RigAgentError(PEOPLE_ONLY, 403);
  if (typeof input.boardId !== "string" || !ID.test(input.boardId)) throw new RigAgentError("Name the board by its project id.", 400);
  const step = typeof input.step === "string" ? input.step : "shots";
  if (input.requestId != null && !(typeof input.requestId === "string" && REQUEST.test(input.requestId))) throw new RigAgentError("requestId must be 1–120 letters, digits, dots, colons, dashes or underscores.", 400);
  const cards = input.cards == null ? undefined : Array.isArray(input.cards) && input.cards.every((c) => typeof c === "string") ? (input.cards as string[]) : null;
  if (cards === null) throw new RigAgentError("Cards are a list of shot card ids.", 400);
  const draft = await readDraft(userId, input.boardId);
  if (!draft) throw new RigAgentError("That board is not yours, or has not been opened in Particl yet.", 404);
  const productionId = draft.project.productionProjectId;
  if (!productionId) throw new RigAgentError("Open this board once in Particl first, so it is saved to a production.", 409);
  const made = await planRigAgentStep({ productionId, draftId: input.boardId, userId, requestId: (input.requestId as string | undefined) ?? `mcp-plan-${randomUUID()}`, step, answers: input.answers, cards, byTool: true });
  /* Pricing is free and repeatable: one bounded drive asks the server's quote for each render. The run has no limit until a person approves, so nothing can be sent.
     The drive runs as the run's own worker does (dispatchRigAgent's continuation): in the workspace with no caller in the store. Inside a token's store the person's
     restore from live membership (lib/pipeline/actor.ts) refuses, so nothing was priced and the run paused as if they had lost access. It drives only this tool's own
     plan while it is unapproved at limit 0 in Ask (a request id cannot point it at another run), and it prices only: it never approves, sends, follows or locks. */
  await rigAgentReady();
  const fresh = await getRun(db(), made.id);
  if (fresh && fresh.plan?.kind === "chips" && fresh.plan.madeBy === "tool" && fresh.owner === userId && fresh.capCredits === 0 && fresh.mode === "ask" && !(await planApprovalOf(db(), fresh.id))) {
    const workspace = requireTenant();
    await runInTenant(workspace, () => driveRigAgent(made.id, { ...deps, budgetMs: deps.budgetMs ?? 20_000, priceOnly: true })).catch(() => undefined);
  }
  const run = (await rigAgentState(productionId, userId, input.boardId)).run;
  const row = await getRun(db(), made.id);
  const view = run && run.id === made.id ? run : made;
  const quote = view.plan?.quote ?? null;
  const takes = (view.paid ?? []).filter((p) => p.tool === "render");
  return {
    id: made.id, state: view.state, step, priced: !!quote,
    total: quote?.total ?? null, ceiling: quote?.ceiling ?? null, approximate: quote?.approximate ?? false,
    shots: takes.map((p) => p.title),
    asks: quote?.asks.length ?? 0,
    reason: quote ? null : unpricedWords(takes),
    answers: row?.plan?.setup ?? null,
    replaced: made.replaced === true,
    needs: "A person approves this plan in Particl. Nothing is spent until they do.",
  };
}
