"use client";
import { useEffect, useRef } from "react";

/*
 * A Make result landing on the board (README § 3.2 `make=made`): Make files every take on a new shot node in the
 * project's draft already, so the result is on the board as a card with no new write. What the board adds is the
 * landing: it glides to that card, lights it briefly, and opens the Library drawer on it. Make (stream 6) says a
 * result was sent with boardMade(); a board on screen for that project takes it.
 */
export type MadeOnBoard = { projectId: string; nodeId: string; name?: string };
/** The same message as a window event, for a part of the app that does not import this file: `detail` is a MadeOnBoard. */
export const BOARD_MADE_EVENT = "particl:board-made";
type Listener = (made: MadeOnBoard) => void;
const listeners = new Set<Listener>();

/** Make sent a take filed on `nodeId` in `projectId` (stream 6 calls this from its made event). */
export function boardMade(made: MadeOnBoard) {
  for (const listener of [...listeners]) listener(made);
}

/** Listens for results made for `projectId`; returns the way to stop. */
export function onBoardMade(projectId: string, fn: (made: MadeOnBoard) => void): () => void {
  const listener: Listener = (made) => { if (made.projectId === projectId) fn(made); };
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The board's side: `fn` runs for each result made for this project while the board is mounted. */
export function useMadeOnBoard(projectId: string | null, fn: (made: MadeOnBoard) => void) {
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });
  useEffect(() => {
    if (!projectId) return;
    const stop = onBoardMade(projectId, (made) => latest.current(made));
    const heard = (event: Event) => {
      const made = (event as CustomEvent<Partial<MadeOnBoard> | null>).detail;
      if (made && made.projectId === projectId && typeof made.nodeId === "string") latest.current({ projectId, nodeId: made.nodeId, ...(made.name ? { name: made.name } : {}) });
    };
    window.addEventListener(BOARD_MADE_EVENT, heard);
    return () => { stop(); window.removeEventListener(BOARD_MADE_EVENT, heard); };
  }, [projectId]);
}
