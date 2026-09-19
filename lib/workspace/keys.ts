import type { AppState } from "./types";

/**
 * The workspace keymap. The shell registers its own bindings here; later PRs
 * (palette, arrows, G, A, Space) add theirs to the same list.
 *
 * Every single-key binding bails while the user is typing — otherwise typing
 * a shot name triggers generation. A binding opts out with `inInputs: true`
 * (⌘K is the deliberate exception).
 */

type KeyTarget = { tagName?: string; isContentEditable?: boolean } | null | undefined;

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: EventTarget | KeyTarget): boolean {
  const el = target as KeyTarget;
  if (!el) return false;
  if (el.tagName && TYPING_TAGS.has(el.tagName.toUpperCase())) return true;
  return el.isContentEditable === true;
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
};

export type KeyBinding<A = unknown> = {
  id: string;
  /** Does this binding claim the event? */
  match: (event: KeyEventLike, ctx: KeyContext) => boolean;
  /** What the binding does, as an action for the caller to run. */
  action: (event: KeyEventLike, ctx: KeyContext) => A;
  /** Fires even when focus is in a text field. */
  inInputs?: boolean;
  /** Needs ⌘/Ctrl held; plain bindings ignore modified keys. */
  modified?: boolean;
  /** Status-bar legend entry, when the binding should be advertised. */
  hint?: (ctx: KeyContext) => { key: string; label: string } | null;
};

export type ShellAction =
  | { type: "page"; index: number }
  | { type: "toggleInspector" }
  | { type: "escape" };

const plain = (event: KeyEventLike) => !event.metaKey && !event.ctrlKey && !event.altKey;

export const SHELL_BINDINGS: KeyBinding<ShellAction>[] = [
  {
    id: "stage",
    match: (e, ctx) => ctx.state.view === "studio" && /^[1-9]$/.test(e.key) && Number(e.key) <= ctx.pageCount,
    action: (e) => ({ type: "page", index: Number(e.key) - 1 }),
    hint: (ctx) => ctx.state.view === "studio" && ctx.pageCount > 1 ? { key: `1–${Math.min(9, ctx.pageCount)}`, label: "stage" } : null,
  },
  {
    id: "inspector",
    match: (e, ctx) => ctx.state.view === "studio" && e.key.toLowerCase() === "i",
    action: () => ({ type: "toggleInspector" }),
    hint: (ctx) => ctx.state.view === "studio" ? { key: "I", label: "inspector" } : null,
  },
  {
    id: "escape",
    match: (e) => e.key === "Escape",
    action: () => ({ type: "escape" }),
  },
];

/** The first binding that claims the event, respecting the typing guard. */
export function resolveKey<A>(bindings: KeyBinding<A>[], event: KeyEventLike, ctx: KeyContext): KeyBinding<A> | null {
  const typing = isTypingTarget(event.target);
  for (const binding of bindings) {
    if (typing && !binding.inInputs) continue;
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
