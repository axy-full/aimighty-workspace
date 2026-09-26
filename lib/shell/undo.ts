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
  /** The project whose draft it changes (a shot deleted in the Rig): it is undone while that project is open. */
  projectId?: string;
};

export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, depth = UNDO_DEPTH): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > depth ? next.slice(next.length - depth) : next;
}

/**
 * The newest entry that belongs to the open project (or to none), the stack
 * without it, and where it stood; failing that the newest (which says which
 * project to open). Null when there is nothing to undo.
 */
export function popUndo(stack: readonly UndoEntry[], projectId?: string | null): { entry: UndoEntry; rest: UndoEntry[]; at: number } | null {
  if (!stack.length) return null;
  let at = stack.length - 1;
  for (let i = stack.length - 1; i >= 0; i--)
    if (!stack[i].projectId || stack[i].projectId === projectId) { at = i; break; }
  return { entry: stack[at], rest: [...stack.slice(0, at), ...stack.slice(at + 1)], at };
}

/** An entry that could not be undone goes back where it stood, so what came after it stays newer. */
export function restoreUndo(stack: readonly UndoEntry[], entry: UndoEntry, at: number, depth = UNDO_DEPTH): UndoEntry[] {
  const next = [...stack.slice(0, at), entry, ...stack.slice(at)];
  return next.length > depth ? next.slice(next.length - depth) : next;
}
