import { listFor } from "./navigation";
import { PAGES } from "./pages";
import type { AppState } from "./types";

/**
 * The workspace keymap. The shell registers its own bindings here; later PRs
 * (palette, arrows, G, A, Space) add theirs to the same list.
 *
 * Two guards, and a binding must clear both:
 *
 *  - typing: every single-key binding bails while the caret is in a field —
 *    otherwise typing a shot name triggers generation. `inInputs: true` opts
 *    out (⌘K is the deliberate exception).
 *  - overlays: while a modal overlay owns the screen, the shell's keys stay
 *    out of it whatever is focused inside — a button, the click-catcher, a
 *    `tabindex` div, none of which is a field. `inOverlays: true` opts out
 *    (⌘K again, and Esc, which must always be able to close).
 *
 * The overlay guard is by containment rather than by state so it cannot be
 * forgotten: a binding added later is inert inside the composer by default.
 */

type KeyTarget =
  | { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown }
  | null
  | undefined;

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Overlays that own the keyboard while they are open. */
export const KEYBOARD_OVERLAYS = ".pxw-composer";

export function isTypingTarget(target: EventTarget | KeyTarget): boolean {
  const el = target as KeyTarget;
  if (!el) return false;
  if (el.tagName && TYPING_TAGS.has(el.tagName.toUpperCase())) return true;
  return el.isContentEditable === true;
}

/** Is the event coming from inside a modal overlay that owns the keyboard? */
export function inKeyboardOverlay(target: EventTarget | KeyTarget): boolean {
  const el = target as KeyTarget;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(KEYBOARD_OVERLAYS) != null;
}

export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | KeyTarget;
};

export type KeyContext = {
  state: AppState;
  /** Pages in the active suite, for 1–9. */
  pageCount: number;
  /** Length of the selection's visible list (shots, filtered takes, cast), for ← →. */
  selectionCount?: number;
  /** The shell has a Generate seam (G). */
  canGenerate?: boolean;
  /** The global Generate composer exists (G with no shot selected). */
  canCompose?: boolean;
  /** The shell has a play seam (Space). */
  canPlay?: boolean;
};

export type KeyBinding<A = unknown> = {
  id: string;
  /** Does this binding claim the event? */
  match: (event: KeyEventLike, ctx: KeyContext) => boolean;
  /** What the binding does, as an action for the caller to run. */
  action: (event: KeyEventLike, ctx: KeyContext) => A;
  /** Fires even when focus is in a text field. */
  inInputs?: boolean;
  /** Fires even when focus is inside a modal overlay (⌘K, Esc). */
  inOverlays?: boolean;
  /** Needs ⌘/Ctrl held; plain bindings ignore modified keys. */
  modified?: boolean;
  /** Status-bar legend entry, when the binding should be advertised. */
  hint?: (ctx: KeyContext) => { key: string; label: string } | null;
};

export type ShellAction =
  | { type: "page"; index: number }
  | { type: "toggleInspector" }
  | { type: "escape" }
  | { type: "palette" }
  | { type: "enterStudio" }
  | { type: "item"; step: 1 | -1 }
  | { type: "generate" }
  | { type: "toggleAtomik" }
  | { type: "play" };

const plain = (event: KeyEventLike) => !event.metaKey && !event.ctrlKey && !event.altKey;

export const SHELL_BINDINGS: KeyBinding<ShellAction>[] = [
  {
    id: "stage",
    match: (e, ctx) => ctx.state.view === "studio" && !ctx.state.composer && /^[1-9]$/.test(e.key) && Number(e.key) <= ctx.pageCount,
    action: (e) => ({ type: "page", index: Number(e.key) - 1 }),
    hint: (ctx) => ctx.state.view === "studio" && ctx.pageCount > 1 ? { key: `1–${Math.min(9, ctx.pageCount)}`, label: "stage" } : null,
  },
  {
    id: "inspector",
    match: (e, ctx) => ctx.state.view === "studio" && !ctx.state.composer && e.key.toLowerCase() === "i",
    action: () => ({ type: "toggleInspector" }),
    hint: (ctx) => ctx.state.view === "studio" ? { key: "I", label: "inspector" } : null,
  },
  {
    /* Esc reaches the shell from inside an overlay too: it is the one key that
       must always be able to close what is open, even if the overlay's own
       handler is gone. */
    id: "escape",
    inOverlays: true,
    match: (e) => e.key === "Escape",
    action: () => ({ type: "escape" }),
  },
];

/** Buttons and links answer Enter themselves; the home binding leaves them alone. */
const activates = (target: KeyEventLike["target"]) => {
  const tag = (target as KeyTarget)?.tagName?.toUpperCase();
  return tag === "BUTTON" || tag === "A";
};

/**
 * The full workspace keymap (04 "Keyboard"), in status-bar legend order.
 * ⌘K / Ctrl+K is the one binding that works inside text fields; every other
 * single key bails while typing (resolveKey). While the palette is open only
 * ⌘K and Esc reach the shell — the palette's own input handles the rest.
 */
export const WORKSPACE_BINDINGS: KeyBinding<ShellAction>[] = [
  {
    id: "palette",
    inInputs: true,
    inOverlays: true,
    modified: true,
    match: (e) => (e.metaKey === true || e.ctrlKey === true) && !e.altKey && e.key.toLowerCase() === "k",
    action: () => ({ type: "palette" }),
    hint: () => ({ key: "⌘K", label: "commands" }),
  },
  SHELL_BINDINGS[0],
  {
    id: "item",
    match: (e, ctx) => ctx.state.view === "studio" && !ctx.state.palette && !ctx.state.composer && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (ctx.selectionCount ?? 0) > 0,
    action: (e) => ({ type: "item", step: e.key === "ArrowRight" ? 1 : -1 }),
    hint: (ctx) => ctx.state.view === "studio" && (ctx.selectionCount ?? 0) > 1 ? { key: "← →", label: "item" } : null,
  },
  {
    id: "atomik",
    match: (e, ctx) => ctx.state.view === "studio" && !ctx.state.palette && !ctx.state.composer && e.key.toLowerCase() === "a",
    action: () => ({ type: "toggleAtomik" }),
    hint: (ctx) => ctx.state.view === "studio" ? { key: "A", label: "atomik" } : null,
  },
  {
    /* ⌘J as well: both old shells bound the Atomik panel to it
       (components/shell/Shell.tsx, components/workbench/Studio.tsx), and the
       new shell is now the surface people arrive on. Not advertised — `A` is
       the legend entry. */
    id: "atomik-cmd",
    modified: true,
    match: (e, ctx) =>
      ctx.state.view === "studio" &&
      !ctx.state.palette &&
      (e.metaKey === true || e.ctrlKey === true) &&
      !e.altKey &&
      e.key.toLowerCase() === "j",
    action: () => ({ type: "toggleAtomik" }),
  },
  {
    /* G is the one key that answers everywhere: the Rig's own Generate when a
       shot is selected, and the global composer otherwise — including Home,
       which has no shot to select. */
    id: "generate",
    match: (e, ctx) => !ctx.state.palette && !ctx.state.composer && e.key.toLowerCase() === "g" && (ctx.state.view === "studio" || ctx.canCompose === true),
    action: () => ({ type: "generate" }),
    hint: (ctx) => ctx.state.view === "studio" && (ctx.canGenerate || ctx.canCompose) ? { key: "G", label: "generate" } : null,
  },
  SHELL_BINDINGS[1],
  {
    id: "play",
    match: (e, ctx) => ctx.state.view === "studio" && !ctx.state.palette && !ctx.state.composer && e.key === " " && ctx.canPlay === true,
    action: () => ({ type: "play" }),
    hint: (ctx) => ctx.state.view === "studio" && ctx.canPlay ? { key: "Space", label: "play" } : null,
  },
  {
    id: "enter",
    match: (e, ctx) => ctx.state.view === "home" && !ctx.state.composer && e.key === "Enter" && !activates(e.target),
    action: () => ({ type: "enterStudio" }),
  },
  SHELL_BINDINGS[2],
];

/** The KeyContext for the current state: page count, the selection's visible list, live seams. */
export function keyContextFor(state: AppState, live: { canGenerate?: boolean; canPlay?: boolean; canCompose?: boolean } = {}): KeyContext {
  const list = state.view === "studio" ? listFor(state.selKind, state.lists, state.libFilter) : null;
  return {
    state,
    pageCount: PAGES[state.suite].length,
    selectionCount: list?.length ?? 0,
    canGenerate: live.canGenerate === true,
    canPlay: live.canPlay === true,
    canCompose: live.canCompose === true,
  };
}

/** Legend order: stage, item, atomik, generate, inspector, play, then ⌘K commands last (04, status bar). */
export function legendBindings(): KeyBinding<ShellAction>[] {
  const [palette, ...rest] = WORKSPACE_BINDINGS;
  return [...rest, palette];
}

/**
 * ← / → over the selection's own visible list, wrapping at both ends
 * (prototype onKey). An id not in the list starts from the first item.
 */
export function stepSelection(list: readonly { id: string }[], selId: string | null, step: 1 | -1): string | null {
  if (!list.length) return null;
  const at = list.findIndex((item) => item.id === selId);
  if (at < 0) return list[0].id;
  return list[(at + step + list.length) % list.length].id;
}

/** The first binding that claims the event, respecting both guards. */
export function resolveKey<A>(bindings: KeyBinding<A>[], event: KeyEventLike, ctx: KeyContext): KeyBinding<A> | null {
  const typing = isTypingTarget(event.target);
  const overlay = inKeyboardOverlay(event.target);
  for (const binding of bindings) {
    if (typing && !binding.inInputs) continue;
    if (overlay && !binding.inOverlays) continue;
    if (!binding.modified && !plain(event)) continue;
    if (binding.match(event, ctx)) return binding;
  }
  return null;
}

export function legend<A>(bindings: KeyBinding<A>[], ctx: KeyContext) {
  return bindings.flatMap((b) => {
    const hint = b.hint?.(ctx);
    return hint ? [hint] : [];
  });
}
