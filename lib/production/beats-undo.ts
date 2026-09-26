import { UNDO_DEPTH } from "../shell/undo";
import type { BeatRemoval } from "./beats";

/**
 * Where a Beats undo lands. A delete on the beat sheet goes on the shell's
 * undo stack (⌘Z, or the toast's Undo on a phone), but ⌘Z can come after the
 * stage that made it has closed — the director moved on to Brief — and a
 * closed stage's editor must never write again: its revision is old, and its
 * save would collide with the page now open. So the undo is applied by the
 * Beats stage that has the project open now, or held for the project until
 * one opens it. Keyed by workspace scope and project, so nothing crosses
 * into another workspace.
 */
/** Puts a removal back; null once it is back, else why it could not go back. */
export type BeatRestore = (removal: BeatRemoval) => string | null;
export type BeatUndoResult = { done: "restored" | "held" } | { done: "missed"; why: string };

const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
/* Each attach is its own slot, so a stage that closes late never closes the one that opened after it. */
const open = new Map<string, { restore: BeatRestore }>();
const held = new Map<string, BeatRemoval[]>();

/** Puts a removal back through the stage that has the project open, or holds it for the next one. */
export function undoBeatRemoval(scope: string, projectId: string, removal: BeatRemoval): BeatUndoResult {
  const key = keyOf(scope, projectId);
  const restore = open.get(key)?.restore;
  if (!restore) {
    held.set(key, [...(held.get(key) ?? []), removal].slice(-UNDO_DEPTH));
    return { done: "held" };
  }
  const why = restore(removal);
  return why ? { done: "missed", why } : { done: "restored" };
}

/**
 * A Beats stage has the project open: it restores from now on, starting with
 * what was held for it, in the order it was undone. Returns what went back,
 * what could not, and the closer to call when the stage leaves.
 */
export function attachBeatsStage(scope: string, projectId: string, restore: BeatRestore): { restored: BeatRemoval[]; missed: { removal: BeatRemoval; why: string }[]; detach: () => void } {
  const key = keyOf(scope, projectId);
  const slot = { restore };
  open.set(key, slot);
  const waiting = held.get(key) ?? [];
  held.delete(key);
  const restored: BeatRemoval[] = [], missed: { removal: BeatRemoval; why: string }[] = [];
  for (const removal of waiting) {
    const why = restore(removal);
    if (why) missed.push({ removal, why }); else restored.push(removal);
  }
  return { restored, missed, detach: () => { if (open.get(key) === slot) open.delete(key); } };
}
