/**
 * The undo stack (README › Right-click menu): every mutation pushes its
 * inverse; the stack holds the last twenty. Pure, so it is unit-tested
 * without a browser.
 *
 * One stack for the shell, but every entry remembers the project it was made
 * in: ⌘Z undoes the newest step of the project that is open, so a Rig shot
 * deleted in one project is never restored into another. Steps from other
 * projects wait on the stack until their project is open again.
 */
export const UNDO_DEPTH = 20;

export type UndoEntry = {
  /** What the toast says once it is undone — "Deleted take restored". */
  label: string;
  /**
   * Puts things back. May be async (a server restore). Throwing means "not
   * now": the shell puts the step back on the stack and says why. Returning a
   * string means the step is spent but could not do all it meant to; the
   * toast says that string instead of `label`.
   */
  undo: () => void | string | Promise<void | string>;
  /** The project the step was made in; the shell stamps it when the step is pushed. Absent: any project. */
  projectId?: string | null;
};

/** What the toast says once an entry is undone. */
export function undoneLabel(entry: UndoEntry, said: void | string): string {
  return typeof said === "string" && said.trim() ? said : entry.label;
}

export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, depth = UNDO_DEPTH): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > depth ? next.slice(next.length - depth) : next;
}

const belongs = (entry: UndoEntry, projectId: string | null | undefined) =>
  projectId === undefined || entry.projectId == null || entry.projectId === projectId;

/**
 * The newest entry for this project and the stack without it; null when there
 * is nothing to undo here. Without a project id, the newest entry of all.
 */
export function popUndo(stack: readonly UndoEntry[], projectId?: string | null): { entry: UndoEntry; rest: UndoEntry[] } | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!belongs(stack[i], projectId)) continue;
    return { entry: stack[i], rest: [...stack.slice(0, i), ...stack.slice(i + 1)] };
  }
  return null;
}

/** Whether ⌘Z has anything to do in this project. */
export function canUndo(stack: readonly UndoEntry[], projectId?: string | null): boolean {
  return stack.some((entry) => belongs(entry, projectId));
}

/**
 * A step bound to the draft it was made in: it runs only while `current()`
 * still names project `made`, and otherwise throws `why` — the shell then
 * puts it back on the stack and says so. The Rig uses this: coming back to a
 * project, the Rig holds the previous project's draft until the new one loads.
 */
export function boundUndo(entry: UndoEntry, made: string | null, current: () => string | null, why: string): UndoEntry {
  return {
    ...entry, projectId: made,
    undo: () => {
      if (current() !== made) throw new Error(why);
      return entry.undo();
    },
  };
}

/** The keyboard half of an undo toast; a phone, with no ⌘Z, gets the toast's Undo button instead. */
export const UNDO_HINT = " · ⌘Z to undo";
export function withUndoHint(text: string): string {
  return text + UNDO_HINT;
}
export function splitUndoHint(text: string): { lead: string; hint: string } {
  return text.endsWith(UNDO_HINT) ? { lead: text.slice(0, -UNDO_HINT.length), hint: UNDO_HINT } : { lead: text, hint: "" };
}
