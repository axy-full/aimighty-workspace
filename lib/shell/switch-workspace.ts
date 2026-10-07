import { useSyncExternalStore } from "react";

/**
 * Switch this session to another of the account's workspaces: the one way every switch control does it (the avatar's
 * Settings menu, Workspace › General, a link to a take in another workspace, the account pages' menu).
 *
 * Every save carries the scope of the workspace it was made in, so an edit that reaches the server after the switch is
 * refused and lost. So, while a switch runs, the board takes no edits (the switch's phase, below: RigProvider holds its
 * writes and the shell lays a "Switching…" veil over the page), and:
 *
 * 1. `drain`: everything this window still has to save to the workspace it is leaving is saved (the board's pending
 *    edit and the team canvas's: components/workspace/rig/RigProvider.tsx › drain); then once more, just before the
 *    route is asked, to be sure nothing came in meanwhile.
 * 2. Only once that has saved: the route (/api/workspaces/switch), which decides whether the switch may happen. From
 *    here on nothing more is sent to the old workspace.
 * 3. Only once the route agreed: `go`, which leaves the page. The board stays frozen until it has gone.
 *
 * A switch that does not happen (a save that failed, a refusal, more than SWITCH_TIMEOUT_MS) unfreezes the board, and
 * what was held meanwhile is saved as usual. Resolves with the sentence to show then; null once the page is leaving.
 */
export const UNSAVED_BEFORE_SWITCH = "Your last edit could not be saved. Try again before switching.";
/** The save failed again: trying once more will not help, so it says what will. */
export const UNSAVED_AGAIN = "Your last edit could not be saved. Copy it somewhere safe, then reload.";
export const SWITCH_TOO_LONG = "Switching took too long. Try again.";
export const SWITCH_FAILED = "Your account could not be changed. Please try again.";
export const SWITCH_TIMEOUT_MS = 25_000;

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
  /** The whole switch's limit (SWITCH_TIMEOUT_MS). */
  timeoutMs?: number;
};

/**
 * Where a switch is: `draining` (saving what is left), `posting` (the route asked: nothing more may be sent to this
 * workspace), `leaving` (agreed: the page is going). Anything but `idle` freezes the board's edits.
 */
export type SwitchPhase = "idle" | "draining" | "posting" | "leaving";
export type SwitchState = { phase: SwitchPhase; id: string | null };
const IDLE: SwitchState = { phase: "idle", id: null };
let state: SwitchState = IDLE;
const listeners = new Set<() => void>();
function enter(next: SwitchState) {
  state = next;
  for (const listener of [...listeners]) listener();
}
export const switchState = (): SwitchState => state;
export function subscribeSwitch(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** The switch now, for a control or the veil: re-renders as it moves. */
export function useSwitchState(): SwitchState {
  return useSyncExternalStore(subscribeSwitch, switchState, () => IDLE);
}
/** Whether the board may take an edit now. */
export const editsFrozen = () => state.phase !== "idle";
/** Whether a save may still be sent to this workspace now (the drain's own, while draining). */
export const sendsAllowed = () => state.phase === "idle" || state.phase === "draining";

/* Saves that failed in a row, across presses: the second says what to do instead of "try again". */
let unsavedInRow = 0;

/* One switch at a time, from whichever control: a second press while one runs (the menu closed and opened again, say)
   waits for that one and gets its answer, and starts nothing of its own. */
let running: Promise<string | null> | null = null;

export function switchWorkspace(request: SwitchRequest): Promise<string | null> {
  if (running) return running;
  /* Agreed already: the page is on its way out. */
  if (state.phase === "leaving") return Promise.resolve(null);
  const run = attempt(request).finally(() => { if (running === run) running = null; });
  running = run;
  return run;
}

/** Unit tests only: a fresh page. */
export function resetSwitchForTests() {
  running = null;
  unsavedInRow = 0;
  enter(IDLE);
}

const GO = Symbol("go");

async function attempt(request: SwitchRequest): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(SWITCH_TOO_LONG); }, request.timeoutMs ?? SWITCH_TIMEOUT_MS);
  });
  enter({ phase: "draining", id: request.id });
  try {
    const outcome = await Promise.race([steps(request, controller.signal), timeout]);
    if (outcome === GO && !controller.signal.aborted) {
      enter({ phase: "leaving", id: request.id });
      request.go();
      return null;
    }
    enter(IDLE);
    return outcome === GO ? SWITCH_TOO_LONG : outcome;
  } catch (cause) {
    enter(IDLE);
    return cause instanceof Error && cause.message ? cause.message : request.fallback ?? SWITCH_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

async function steps({ id, fetch, drain, fallback = SWITCH_FAILED }: SwitchRequest, signal: AbortSignal): Promise<string | typeof GO> {
  if (drain) {
    /* Saved, then saved again just before the route is asked: nothing may have come in between. */
    for (let pass = 0; pass < 2; pass++) {
      const saved = await drain().catch(() => false);
      if (signal.aborted) return SWITCH_TOO_LONG;
      if (!saved) return ++unsavedInRow >= 2 ? UNSAVED_AGAIN : UNSAVED_BEFORE_SWITCH;
    }
    unsavedInRow = 0;
  }
  enter({ phase: "posting", id });
  try {
    const response = await fetch("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }), signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return typeof body?.error === "string" && body.error ? body.error : fallback;
    }
  } catch (cause) {
    if (signal.aborted) return SWITCH_TOO_LONG;
    return cause instanceof Error && cause.message ? cause.message : fallback;
  }
  return GO;
}
