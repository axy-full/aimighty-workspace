import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import { draftRequest, DraftRequestError } from "@/lib/workbench/draft-request";

/*
 * The board agent's reads and calls, on today's team-canvas route (`agent.*`,
 * lib/workbench/rig-agent.ts). Nothing here is a new way to spend: planning is
 * asked with the limit the person pressed, and every render after it asks again
 * at its own price through the approvals queue (lib/control-room/approve.ts).
 */
export type AskTerms = { limit: number; jobCeiling: number; planning: number | null };
export type AgentAnswer = { enabled: boolean; run: RigAgentRunView | null; ask?: AskTerms | null };

export const TEAM_CANVAS = "/api/workbench/team-canvas";
export const READ_FAILED = "Atomik's board could not be read.";
export const BUSY_MS = 1500;
export const IDLE_MS = 12_000;

export function isAnswer(value: unknown): value is { agent: AgentAnswer } {
  const agent = (value as { agent?: AgentAnswer } | null)?.agent;
  return !!agent && typeof agent.enabled === "boolean" && (agent.run === null || (typeof agent.run === "object" && typeof agent.run.id === "string"));
}

/** The run and the ask's terms; with `attachments` (`upload:<id>`), planning's figure prices those files in. */
export async function readAgent(scope: string, productionId: string, draftId: string | null, attachments: readonly string[] = []): Promise<AgentAnswer> {
  const params = new URLSearchParams({ productionId, agent: "1", ...(draftId ? { projectId: draftId } : {}) });
  for (const id of attachments) params.append("attachment", id);
  const value = await draftRequest<unknown>(`${TEAM_CANVAS}?${params}`, scope);
  if (!isAnswer(value)) throw new Error(READ_FAILED);
  return value.agent;
}

/** Why a read was refused, in the server's words when it said (an attached file it won't take), else a plain line. */
export function readProblem(error: unknown): string {
  return error instanceof DraftRequestError && error.status && error.status < 500 && error.status !== 401 && error.message ? error.message : READ_FAILED;
}

/** A person's call on the run (stop, undo, raise the limit, ask). Answers the run as it is now, or why not. */
export async function callAgent(scope: string, productionId: string, body: Record<string, unknown>): Promise<{ ok: true; agent: AgentAnswer } | { ok: false; error: string }> {
  try {
    const value = await draftRequest<unknown>(TEAM_CANVAS, scope, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId, ...body }) });
    if (!isAnswer(value)) throw new Error(READ_FAILED);
    return { ok: true, agent: { ...value.agent, ask: value.agent.ask ?? null } };
  } catch (error) {
    return { ok: false, error: error instanceof DraftRequestError && error.status && error.status < 500 && error.status !== 401 ? error.message : "Atomik could not do that just now. Try again." };
  }
}

/** The ask, in the words the run is asked in: the person's words with the board's aspect and length. */
export function goalOf(words: string, extra: { aspect?: string | null; seconds?: number | null } = {}): string {
  const bits = [extra.aspect ? `${extra.aspect}` : null, extra.seconds ? `${extra.seconds} s` : null].filter(Boolean);
  return `${words.trim()}${bits.length ? ` (${bits.join(", ")})` : ""}`.slice(0, 2000);
}
