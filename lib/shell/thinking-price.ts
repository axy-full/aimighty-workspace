/**
 * Atomik's thinking on a new board as a price: the answer of GET /api/workbench/team-canvas?agent=1&board=new, read
 * (rig-agent.ts newBoardAskTerms). Pure, so the new interface's price layer (lib/v12/quote.ts) and Home's hook
 * (components/graphite/home/use-thinking-price.ts) read it the same way.
 *
 * `off`: building with Atomik is switched off for this workspace (RIG_AGENT_ENABLED): no figure, no Start.
 * `unpriced`: the planner's price could not be read: no figure, so Start can't be pressed.
 */
export type Thinking =
  | { state: "loading" }
  | { state: "ready"; credits: number }
  | { state: "off" }
  | { state: "unpriced" }
  | { state: "error"; message: string };

export const THINKING_READ_FAILED = "Atomik's thinking price didn't load.";

/** The answer of the agent read, as Home words it. Exported for the unit spec. */
export function thinkingFrom(body: unknown): Thinking {
  const agent = (body as { agent?: { enabled?: unknown; ask?: { planning?: unknown } | null } } | null)?.agent;
  if (!agent || typeof agent.enabled !== "boolean") return { state: "error", message: THINKING_READ_FAILED };
  if (!agent.enabled) return { state: "off" };
  const planning = agent.ask?.planning;
  return typeof planning === "number" && Number.isFinite(planning) && planning > 0 ? { state: "ready", credits: planning } : { state: "unpriced" };
}
