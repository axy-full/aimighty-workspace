"use client";
/**
 * The Rig's commands as the shell reaches them (owner, 23 September: "unable
 * to delete things from the rig section"). The Rig registers how it deletes
 * a shot while it is on screen; the Suites shell registers where an undo goes.
 * Module-level slots, like drop-targets.ts, so the legacy tree stays untouched.
 */
/** `projectId`: the project the shot was deleted from — the undo runs while that project is open. */
export type RigUndo = { label: string; undo: () => void | Promise<void>; projectId?: string };
let deleteShot: ((id: string) => string | null) | null = null;
let undoSink: ((entry: RigUndo) => void) | null = null;
export function setRigDeleteHandler(handler: ((id: string) => string | null) | null) { deleteShot = handler; }
export function rigDeleteHandler() { return deleteShot; }
export function setRigUndoSink(sink: ((entry: RigUndo) => void) | null) { undoSink = sink; }
export function rigUndoSink() { return undoSink; }
