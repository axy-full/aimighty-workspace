"use client";
import { createContext, useContext, useEffect } from "react";
import type { RoomPeer } from "@/lib/workbench/team-canvas-model";
import type { BoardCtx, CardDef } from "./cards/types";
import type { PlacedBoard } from "./layout-cards";

/*
 * What the board's node wrapper (BoardNode) reads: the laid-out cards, their
 * definitions, the context every card gets, and who else is looking at which
 * card. Cards themselves read only their props, or `useBoard()`.
 */
export type BoardInternals = {
  placed: PlacedBoard;
  defs: ReadonlyMap<string, CardDef<unknown>>;
  ctx: BoardCtx;
  /** A teammate looking at a card (their selection), by card id. */
  watchers: ReadonlyMap<string, RoomPeer>;
  /** The card Atomik is working on, and what it is doing. */
  atomik: { card: string; doing: string; color: string } | null;
  seams: BoardSeams;
  /** The free card whose words are being edited on the board (a note's text, a label's line), and how they are kept. */
  editing: string | null;
  finishEdit: (id: string, value: string | null) => void;
  /** Whether a card takes drops (its definition has `accepts`), and a drop on it (a Library file's id as text/plain). */
  takesDrops: (cardId: string) => boolean;
  dropOn: (cardId: string, data: DataTransfer) => void;
  /** A card just made in Make, lit for a moment (README § 3.2 `made`). */
  lit: string | null;
};

/**
 * What other streams plug into the board while their parts are on screen: review mode (stream 5) and the docked
 * panel's input (stream 7). `useProvideBoardSeam("review", fn)` from a component the board mounts.
 */
export type SeamName = "review" | "atomik";
type SeamFn = (arg?: string) => void;
export class BoardSeams {
  private fns = new Map<SeamName, SeamFn>();
  provide(name: SeamName, fn: SeamFn | null) { if (fn) this.fns.set(name, fn); else this.fns.delete(name); }
  call(name: SeamName, arg?: string) { this.fns.get(name)?.(arg); }
}

const Internals = createContext<BoardInternals | null>(null);
export const BoardInternalsProvider = Internals.Provider;

export function useBoardInternals(): BoardInternals {
  const value = useContext(Internals);
  if (!value) throw new Error("A board card is drawn inside the board.");
  return value;
}

/** The board around a card: selection, glide, the Rig seam and the rest (cards/types.ts › BoardCtx). */
export function useBoard(): BoardCtx {
  return useBoardInternals().ctx;
}

/** Plugs a stream's part into the board while it is mounted (stream 5: "review"; stream 7: "atomik"). */
export function useProvideBoardSeam(name: SeamName, fn: SeamFn) {
  const { seams } = useBoardInternals();
  useEffect(() => { seams.provide(name, fn); return () => seams.provide(name, null); }, [fn, name, seams]);
}
