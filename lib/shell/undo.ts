/**
 * The undo stack (README › Right-click menu): every mutation pushes its
 * inverse; the stack holds the last twenty. Pure, so it is unit-tested
 * without a browser.
 */
export const UNDO_DEPTH = 20;

export type UndoEntry = {
  /** What the toast says once it is undone — "Deleted take restored". */
  label: string;
  /** Puts things back. May be async (a server restore). */
  undo: () => void | Promise<void>;
};

export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, depth = UNDO_DEPTH): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > depth ? next.slice(next.length - depth) : next;
}

/** The newest entry and the stack without it; null when there is nothing to undo. */
export function popUndo(stack: readonly UndoEntry[]): { entry: UndoEntry; rest: UndoEntry[] } | null {
  if (!stack.length) return null;
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
