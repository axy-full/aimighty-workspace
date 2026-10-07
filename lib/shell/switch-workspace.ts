/**
 * Switch this session to another of the account's workspaces: the one way every switch control does it (the avatar's
 * Settings menu, Workspace › General, a link to a take in another workspace, the account pages' menu).
 *
 * 1. `drain`: everything this window still has to save to the workspace it is leaving is saved first (the board's
 *    pending edit and the team canvas's: components/workspace/rig/RigProvider.tsx › drain). Every save carries this
 *    workspace's scope, so a save sent after the switch would be refused and the edit lost.
 * 2. Only once that has saved: the route (/api/workspaces/switch), which decides whether the switch may happen.
 * 3. Only once the route agreed: `go`, which leaves the page.
 *
 * Resolves with the sentence to show when the switch did not happen (nothing was switched, and the edits stay here,
 * still editable); null once the page is leaving.
 */
export const UNSAVED_BEFORE_SWITCH = "Your last edit could not be saved. Try again before switching.";
export const SWITCH_FAILED = "Your account could not be changed. Please try again.";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type SwitchRequest = {
  id: string;
  /** A fetch that carries the page's workspace scope (lib/useScopedFetch). */
  fetch: Fetch;
  /** Leaves the page, into the workspace now active. */
  go: () => void;
  /** Saves what is still to be saved; true once nothing is left unsaved. Omitted where nothing is ever pending. */
  drain?: (() => Promise<boolean>) | null;
  /** The sentence for a refusal that names no reason of its own. */
  fallback?: string;
};

/* One switch at a time, from whichever control: a second press while one runs (the menu closed and opened again, say)
   waits for that one and gets its answer, and starts nothing of its own. */
let running: Promise<string | null> | null = null;

export function switchWorkspace(request: SwitchRequest): Promise<string | null> {
  if (running) return running;
  const run = attempt(request).finally(() => { if (running === run) running = null; });
  running = run;
  return run;
}

async function attempt({ id, fetch, go, drain, fallback = SWITCH_FAILED }: SwitchRequest): Promise<string | null> {
  if (drain) {
    const saved = await drain().catch(() => false);
    if (!saved) return UNSAVED_BEFORE_SWITCH;
  }
  try {
    const response = await fetch("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return typeof body?.error === "string" && body.error ? body.error : fallback;
    }
  } catch (cause) {
    return cause instanceof Error && cause.message ? cause.message : fallback;
  }
  go();
  return null;
}
