import { useSyncExternalStore } from "react";

/**
 * Switch this session to another of the account's workspaces: the one way every switch control does it (the avatar's
 * Settings menu, Workspace › General, a link to a take in another workspace, the account pages' menu).
 *
 * Every save carries the scope of the workspace it was made in, so an edit that reaches the server after the switch is
 * refused and lost. So, while a switch runs, the board takes no edits (the switch's phase, below: RigProvider holds its
 * writes and the shell lays a "Switching…" veil over the page), and:
 *
 * 1. The drains: everything this window still has to save to the workspace it is leaving is saved. Every editor that
 *    saves a draft registers its drain here (registerDrain), whichever control starts the switch: the board and its
 *    team canvas (RigProvider), and both draft-editor stores (lib/workspace/draft-editor.ts, use-draft-editor.ts: Edit
 *    & Sound, the Business pages). Then all of them once more, just before the route is asked.
 * 2. Only once that has saved: the route (/api/workspaces/switch), which decides whether the switch may happen. From
 *    here on nothing more is sent to the old workspace.
 * 3. Only once the route agreed: `go`, which leaves the page. The board stays frozen until it has gone. A route that
 *    did not answer within the limit is asked who this session is now (/api/me): a switch that landed still leaves.
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
  /** The sentence for a refusal that names no reason of its own. */
  fallback?: string;
  /** The whole switch's limit (SWITCH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The workspace this session is in now, read when the route did not answer in time (default: /api/me). */
  whoami?: () => Promise<string | null>;
  /** How long that question may take before the switch counts as not landed (default 5 s; tests shorten it). */
  whoamiTimeoutMs?: number;
};

/* ── The drains ───────────────────────────────────────────────────────── */
export type Drain = () => Promise<boolean>;
const drains = new Set<Drain>();
/**
 * An editor that saves drafts to this workspace: its drain saves everything it still has to (true once nothing is left
 * unsaved, or there was nothing). Registered while it can hold an edit; returns the unregister.
 */
export function registerDrain(drain: Drain): () => void {
  drains.add(drain);
  return () => { drains.delete(drain); };
}
async function drainAll(): Promise<boolean> {
  for (const drain of [...drains]) if (!(await drain().catch(() => false))) return false;
  return true;
}

/** What an editing call answers while a switch runs (it changes nothing): callers show it as they show any refusal. */
export const SWITCHING = "Switching…";
/** The refusal for an edit now: SWITCHING while a switch runs, else null. */
export const whileSwitching = (): string | null => (editsFrozen() ? SWITCHING : null);

/**
 * Edits that came in while a switch ran (the app's own: a filed take, a teammate's change), kept as UPDATER functions and
 * replayed in order once it did not happen, each run on the draft as it is then — never a project computed before it was
 * held, which would undo what a save merged in from another window meanwhile.
 */
export function createHeldEdits<E>() {
  const held: E[] = [];
  return {
    hold: (edit: E) => { held.push(edit); },
    get size() { return held.length; },
    /** Takes every held edit, in order, to run now. */
    release: (): E[] => held.splice(0),
  };
}

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
  drains.clear();
  enter(IDLE);
}

async function sessionWorkspace(): Promise<string | null> {
  const response = await fetch("/api/me", { cache: "no-store", signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS) });
  if (!response.ok) return null;
  const me = (await response.json().catch(() => null)) as { workspace?: { id?: unknown } } | null;
  return typeof me?.workspace?.id === "string" ? me.workspace.id : null;
}

const GO = Symbol("go");
/* The page is still frozen while it asks who this session is now, so that question is bounded too. */
const WHOAMI_TIMEOUT_MS = 5_000;

/* The control that was pressed (focused as the switch began): focus goes back to it when the switch does not happen. */
let pressed: Element | null = null;
export const pressedControl = (): Element | null => pressed;

async function attempt(request: SwitchRequest): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(SWITCH_TOO_LONG); }, request.timeoutMs ?? SWITCH_TIMEOUT_MS);
  });
  pressed = typeof document === "undefined" ? null : document.activeElement;
  enter({ phase: "draining", id: request.id });
  try {
    let outcome = await Promise.race([steps(request, controller.signal), timeout]);
    /* Out of time with the route already asked: the switch may have landed all the same. Still frozen, ask who this is now. */
    if (outcome === SWITCH_TOO_LONG && state.phase === "posting") {
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const now = await Promise.race([
        (request.whoami ?? sessionWorkspace)().catch(() => null),
        new Promise<null>((resolve) => { giveUp = setTimeout(() => resolve(null), request.whoamiTimeoutMs ?? WHOAMI_TIMEOUT_MS); }),
      ]);
      clearTimeout(giveUp);
      if (now === request.id) outcome = GO;
    }
    if (outcome === GO) {
      enter({ phase: "leaving", id: request.id });
      request.go();
      return null;
    }
    enter(IDLE);
    return outcome;
  } catch (cause) {
    enter(IDLE);
    return cause instanceof Error && cause.message ? cause.message : request.fallback ?? SWITCH_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

async function steps({ id, fetch, fallback = SWITCH_FAILED }: SwitchRequest, signal: AbortSignal): Promise<string | typeof GO> {
  if (drains.size) {
    /* Saved, then saved again just before the route is asked: nothing may have come in between. */
    for (let pass = 0; pass < 2; pass++) {
      const saved = await drainAll();
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
