/**
 * The Production suite's agent (owner, 23 September: "Let everything … be
 * dictated by an agent. An agent that the user gets to choose. Claude, Grok or
 * Open AI."). One choice — family, model, effort — remembered per viewer and
 * used by every agentic step of the suite: the script writer, the beat
 * breakdown, storyboard prompts, sketch reading and the Rig's prompt.
 */
export type AgentFamily = "claude" | "grok" | "openai";
export const AGENT_FAMILIES: { id: AgentFamily; label: string; prefix: string }[] = [
  { id: "claude", label: "Claude", prefix: "anthropic/" },
  { id: "grok", label: "Grok", prefix: "spacexai/" },
  { id: "openai", label: "OpenAI", prefix: "openai/" },
];
export type AgentChoice = { family: AgentFamily; model: string; effort: string };
export const AGENT_KEY = "particl:production-agent:v1";
export const DEFAULT_AGENT: AgentChoice = { family: "claude", model: "", effort: "auto" };

export function agentFamilyOf(modelId: string): AgentFamily | null {
  return AGENT_FAMILIES.find((f) => modelId.startsWith(f.prefix))?.id ?? null;
}
export function agentLabel(family: AgentFamily): string {
  return AGENT_FAMILIES.find((f) => f.id === family)!.label;
}

type Model = { id: string; released?: number; efforts?: { value: string }[] };
/** The family's models, newest first. */
export function familyModels<T extends Model>(models: readonly T[], family: AgentFamily): T[] {
  const prefix = AGENT_FAMILIES.find((f) => f.id === family)!.prefix;
  return models.filter((m) => m.id.startsWith(prefix)).sort((a, b) => (b.released ?? 0) - (a.released ?? 0));
}
/** The model a choice resolves to today: the one picked while it is still offered, else the family's newest. */
export function resolveAgent<T extends Model>(models: readonly T[], choice: AgentChoice): { model: T | null; effort: string } {
  const offered = familyModels(models, choice.family);
  const model = offered.find((m) => m.id === choice.model) ?? offered[0] ?? null;
  const effort = model && model.id === choice.model && (model.efforts ?? []).some((e) => e.value === choice.effort) ? choice.effort : "auto";
  return { model, effort };
}

export function parseAgent(raw: string | null): AgentChoice {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<AgentChoice> | null;
    if (!value || !AGENT_FAMILIES.some((f) => f.id === value.family)) return DEFAULT_AGENT;
    const model = typeof value.model === "string" && value.model.length <= 120 && agentFamilyOf(value.model) === value.family ? value.model : "";
    const effort = typeof value.effort === "string" && /^[a-z0-9:]{1,40}$/.test(value.effort) ? value.effort : "auto";
    return { family: value.family as AgentFamily, model, effort };
  } catch {
    return DEFAULT_AGENT;
  }
}
export function readAgent(): AgentChoice {
  try { return parseAgent(localStorage.getItem(AGENT_KEY)); } catch { return DEFAULT_AGENT; }
}
export function writeAgent(choice: AgentChoice) {
  try { localStorage.setItem(AGENT_KEY, JSON.stringify(choice)); } catch { /* a convenience; the choice still holds for this page */ }
}

/**
 * An agent run's price, in the unit this workspace pays in. A workspace on
 * the platform's keys sees credits and only credits — never the provider's
 * dollars, even if a figure arrived with them. A workspace that pays its
 * vendors in dollars sees the provider's dollar ceiling (its credit figure
 * is 0, not a price).
 */
export function agentPrice(value: { estimateCredits: number; estimateUsd?: number | null }, inCredits: boolean): string {
  if (!inCredits && value.estimateUsd != null && Number.isFinite(value.estimateUsd)) return dollars(value.estimateUsd);
  return `${Math.max(0, Math.round(value.estimateCredits)).toLocaleString("en-US")} cr`;
}
/** What a finished run cost, in the same unit; null while it is still settling. */
export function agentCharged(job: { credits: number | null; costUsd?: number | null }, inCredits: boolean): string | null {
  if (!inCredits) return job.costUsd != null && Number.isFinite(job.costUsd) ? dollars(job.costUsd) : null;
  return job.credits == null ? null : `${Math.max(0, Math.round(job.credits)).toLocaleString("en-US")} cr`;
}
function dollars(n: number): string {
  return `$${Math.max(0, n).toFixed(n >= 1 ? 2 : 4)}`;
}

/** The director's notes went with this request (so the box can be cleared once it is confirmed). */
export function notesSent(input: { instructions?: string } | null | undefined, notes: string): boolean {
  const said = notes.trim();
  return Boolean(input && said && (input.instructions ?? "").trim() === said);
}
