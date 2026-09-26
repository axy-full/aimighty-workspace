import type { SuiteId } from "@/lib/suites";

/**
 * A suite agent's unsent request box, kept per workspace, suite and project in
 * localStorage (cleared on sign-out with every other `aw_draft:` key), and the
 * one channel through which the Suites ⌘K "Ask Atomik: …" hands it words.
 * Nothing here sends anything: the person still reads the request and presses
 * Plan.
 */
export type AgentDraft = { request: string; refs: string[] };
export const AGENT_DRAFT_EVENT = "particl-suite-agent-draft";
const MAX_REQUEST = 11000;
const MAX_REFS = 12;

export const agentDraftKey = (scope: string | null | undefined, suite: SuiteId, projectId: string) =>
  scope ? `aw_draft:suite-agent:${encodeURIComponent(scope)}:${suite}:${encodeURIComponent(projectId)}` : null;

const refsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, MAX_REFS) : [];

/** A stored draft, or the empty one when there is none or it cannot be read. */
export function parseAgentDraft(stored: string | null): AgentDraft {
  try {
    const parsed = JSON.parse(stored ?? "null");
    if (parsed && typeof parsed.request === "string" && Array.isArray(parsed.refs)) return { request: parsed.request.slice(0, MAX_REQUEST), refs: refsOf(parsed.refs) };
  } catch { /* An unreadable creative draft is not a paid recovery record. */ }
  return { request: "", refs: [] };
}

/**
 * The box's own last edit, and the stored values it answers for: what storage
 * held when it was typed, and what it wrote. `seen` keeps the edit on screen
 * when storage refuses the write (private mode); anything else in storage —
 * a ⌘K request, another tab — is newer than the edit, and wins.
 */
export type AgentDraftEdit = { key: string | null; value: AgentDraft; seen: (string | null)[] };
export function shownAgentDraft(key: string | null, stored: string | null, edit: AgentDraftEdit | null): AgentDraft {
  if (edit && edit.key === key && edit.seen.includes(stored)) return edit.value;
  return parseAgentDraft(stored);
}

/** Hand a request to this suite's agent box, keeping the references already selected; an open box shows it at once. */
export function prefillAgentRequest(scope: string | null | undefined, suite: SuiteId, projectId: string, request: string): boolean {
  const key = agentDraftKey(scope, suite, projectId);
  const text = request.trim().slice(0, MAX_REQUEST);
  if (!key || !text) return false;
  try {
    const { refs } = parseAgentDraft(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify({ request: text, refs }));
    window.dispatchEvent(new Event(AGENT_DRAFT_EVENT));
    return true;
  } catch { return false; }
}

/*
 * ⌘K can ask before any project is open (the list is still loading, or failed
 * to load). The words wait in this tab's sessionStorage and land in the Agent
 * box as soon as a project resolves, instead of being dropped.
 */
const pendingKey = (scope: string) => `particl-agent-ask:${encodeURIComponent(scope)}`;
export function holdAgentRequest(scope: string | null | undefined, request: string): boolean {
  const text = request.trim().slice(0, MAX_REQUEST);
  if (!scope || !text) return false;
  try { sessionStorage.setItem(pendingKey(scope), text); return true; } catch { return false; }
}
export function takeHeldAgentRequest(scope: string | null | undefined): string | null {
  if (!scope) return null;
  try {
    const text = sessionStorage.getItem(pendingKey(scope));
    if (text != null) sessionStorage.removeItem(pendingKey(scope));
    return text?.trim() ? text : null;
  } catch { return null; }
}
