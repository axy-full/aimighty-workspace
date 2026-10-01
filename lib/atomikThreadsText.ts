/**
 * Atomik threads, the rules the server and the browser read alike
 * (lib/atomikThreads.ts keeps them; the rail, the phone sheet and the Suites
 * Agent page show them). Pure, and free of imports.
 */

export type ThreadState = "new" | "planning" | "approval" | "running" | "stopped" | "done";

export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  new: "New",
  planning: "Planning",
  approval: "Waiting for approval",
  running: "Running",
  stopped: "Stopped",
  done: "Done",
};

export type Thread = {
  id: string;
  projectId: string | null;
  /** Its place among the project's threads by when each was started: 1 is the project's first. */
  number: number;
  /** Its title, or while it has none, its first ask. */
  title: string;
  state: ThreadState;
  startedByYou: boolean;
  startedByName: string | null;
  startedAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  archivedByYou: boolean;
  archivedByName: string | null;
};

export const THREAD_LIMITS = { title: 80, list: 100 } as const;

/** Said wherever an archived thread refuses new work. */
export const ARCHIVED_NOTE = "This thread is archived. Restore it to continue here.";

/** What a chat is called until its first reply names it (lib/atomik.ts › createChat). */
const UNNAMED = "New chat";

/** A title a person gives a thread: one printable line, at most 80 characters; null when nothing is left. */
export function cleanThreadTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  /* eslint-disable-next-line no-control-regex */
  const line = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, THREAD_LIMITS.title).trim() : null;
}

/** What a thread is called in its project's list: its title, or while it has none, its first ask. */
export function threadTitle(title: string, firstAsk: string | null): string {
  if (title && title !== UNNAMED) return title;
  const ask = cleanThreadTitle(firstAsk ?? "");
  if (!ask) return "New thread";
  return ask.length > 60 ? `${ask.slice(0, 59).trimEnd()}…` : ask;
}

/** Where a thread stands, from its chat and its steps. */
export function threadState(r: { status: string; needsApproval: boolean; rendering: boolean; messages: number }): ThreadState {
  if (r.status === "running") return "planning";
  if (r.needsApproval) return "approval";
  if (r.rendering) return "running";
  if (r.status === "failed") return "stopped";
  if (!r.messages) return "new";
  return "done";
}

/** Who started a thread, as its row says it. */
export const startedBy = (t: Pick<Thread, "startedByYou" | "startedByName">) => (t.startedByYou ? "you" : t.startedByName ?? "a teammate");

/** `just now`, `5 min ago`, `3 h ago`, `Sep 30`: when a thread last moved. */
export function lastActivity(at: number, now = Date.now()): string {
  const gap = Math.max(0, now - at);
  if (gap < 60_000) return "just now";
  if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} min ago`;
  if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The chat a saved planning request was for, from its URL (`/api/atomik/<chat>`). */
export function chatOfRequest(url: string): string | null {
  const m = /^\/api\/atomik\/([^/?#]+)$/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}
