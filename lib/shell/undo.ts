/**
 * The undo stack (README › Right-click menu): every mutation pushes its
 * inverse; the stack holds the last twenty. Pure, so it is unit-tested
 * without a browser.
 */
export const UNDO_DEPTH = 20;

export type UndoEntry = {
  /** What the toast says once it is undone — "Deleted take restored". */
  label: string;
  /** Puts things back. May be async (a server restore). A string it returns
   *  is said instead of `label` — when the undo could not do all it meant to. */
  undo: () => void | string | Promise<void | string>;
};

/** What the toast says once an entry is undone. */
export function undoneLabel(entry: UndoEntry, said: void | string): string {
  return typeof said === "string" && said.trim() ? said : entry.label;
}

export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, depth = UNDO_DEPTH): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > depth ? next.slice(next.length - depth) : next;
}

/** The newest entry and the stack without it; null when there is nothing to undo. */
export function popUndo(stack: readonly UndoEntry[]): { entry: UndoEntry; rest: UndoEntry[] } | null {
  if (!stack.length) return null;
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) };
}

/** The keyboard half of an undo toast; a phone, with no ⌘Z, gets the toast's Undo button instead. */
export const UNDO_HINT = " · ⌘Z to undo";
export function withUndoHint(text: string): string {
  return text + UNDO_HINT;
}
export function splitUndoHint(text: string): { lead: string; hint: string } {
  return text.endsWith(UNDO_HINT) ? { lead: text.slice(0, -UNDO_HINT.length), hint: UNDO_HINT } : { lead: text, hint: "" };
}
