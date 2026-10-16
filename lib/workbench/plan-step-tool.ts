import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { driveRigAgent, planRigAgentStep, rigAgentState, RigAgentError, type TickDeps } from "./rig-agent";
import { getRun, rigAgentReady } from "./rig-agent-store";
import { readDraft } from "./records";

/**
 * `plan_step`: the tool behind Agent mode's quick plan (rule 11). The button (`agent.planStep` on the board's route), Atomik and an outside agent over MCP all make the
 * same plan: the server's own plan for a board step from its quick answers (lib/workbench/rig-agent-chips.ts), priced by the server's quote.
 *
 * It PREPARES and PRICES only. It spends nothing and approves nothing: the plan waits on the board for the person who owns it, who approves it once in Particl
 * (`agent.approvePlan`, a signed-in session, people only). Declared once here; the MCP tool and the route read this.
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
  shots: { title: string; credits: number | null }[];
  /** Renders that ask on their own (over the per-job line, or for an admin). */
  asks: number;
  /** Why it is not priced or not ready, in words. */
  reason: string | null;
  answers: { quality: string; length: number } | null;
  /** It replaced an earlier plan a tool made that was still waiting; never one a person made. */
  replaced: boolean;
  needs: "A person approves this plan in Particl. Nothing is spent until they do.";
};

const ID = /^[a-zA-Z0-9-]{1,100}$/;
const REQUEST = /^[A-Za-z0-9._:-]{1,120}$/;

/** Makes the plan for a person (or for a token acting as them), prices it, and says what it came to. Never approves, never sends, never reserves. */
export async function preparePlanStep(userId: string, input: PlanStepInput, deps: TickDeps & { budgetMs?: number } = {}): Promise<PlanStepSummary> {
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
  /* Pricing is free and repeatable: one bounded drive asks the server's quote for each render. The run has no limit until a person approves, so nothing can be sent. */
  await driveRigAgent(made.id, { ...deps, budgetMs: deps.budgetMs ?? 20_000 }).catch(() => undefined);
  await rigAgentReady();
  const run = (await rigAgentState(productionId, userId, input.boardId)).run;
  const row = await getRun(db(), made.id);
  const view = run && run.id === made.id ? run : made;
  const quote = view.plan?.quote ?? null;
  const takes = (view.paid ?? []).filter((p) => p.tool === "render");
  return {
    id: made.id, state: view.state, step, priced: !!quote,
    total: quote?.total ?? null, ceiling: quote?.ceiling ?? null, approximate: quote?.approximate ?? false,
    shots: takes.map((p) => ({ title: p.title, credits: p.quote })),
    asks: quote?.asks.length ?? 0,
    reason: quote ? null : view.plan?.blocked ?? view.reason ?? null,
    answers: row?.plan?.setup ?? null,
    replaced: made.replaced === true,
    needs: "A person approves this plan in Particl. Nothing is spent until they do.",
  };
}
