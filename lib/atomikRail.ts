"use client";

import { useSyncExternalStore } from "react";

/**
 * Atomik's rail state, at app level (design/particl-v2/README.md §5):
 * `closed`, `compact` (300) or `expanded` (420), persisted per user. ⌘J
 * toggles closed ↔ the last open state; Esc closes. The header button reads
 * it (open → `.35` border and `--selected` fill); the rail renders from it
 * (step 3); nothing else of Atomik exists while it is closed.
 *
 * A module store read through `useSyncExternalStore`, not React state in a
 * provider: the server always renders `closed`, the browser's own copy is
 * read once after hydration, and no effect ever calls setState.
 */
export type RailState = "closed" | "compact" | "expanded";
type Open = Exclude<RailState, "closed">;
type Snap = { readonly state: RailState; readonly last: Open };

const SERVER: Snap = { state: "closed", last: "compact" };
let snap: Snap = SERVER;
let key = "";
const subs = new Set<() => void>();
const emit = () => { for (const s of subs) s(); };
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

const isOpen = (v: unknown): v is Open => v === "compact" || v === "expanded";
const isState = (v: unknown): v is RailState => v === "closed" || isOpen(v);

/** Attach the store to a user; reads what that user left it at. */
export function bindAtomikRail(userKey: string) {
  key = `particl:atomik:${userKey}`;
  try {
    const raw = localStorage.getItem(key);
    const p = raw ? (JSON.parse(raw) as Partial<Snap>) : null;
    const next: Snap = p && isState(p.state) ? { state: p.state, last: isOpen(p.last) ? p.last : "compact" } : SERVER;
    if (next.state !== snap.state || next.last !== snap.last) { snap = next; emit(); }
  } catch { /* no storage: the rail starts closed, as it would for anyone new */ }
}

export function setAtomikRail(state: RailState) {
  if (state === snap.state) return;
  snap = { state, last: state === "closed" ? snap.last : state };
  try { if (key) localStorage.setItem(key, JSON.stringify(snap)); } catch { /* per-viewer convenience only */ }
  emit();
}

export const toggleAtomikRail = () => setAtomikRail(snap.state === "closed" ? snap.last : "closed");

export function useAtomikRail() {
  const s = useSyncExternalStore(subscribe, () => snap, () => SERVER);
  return {
    state: s.state,
    open: s.state !== "closed",
    set: setAtomikRail,
    toggle: toggleAtomikRail,
    close: () => setAtomikRail("closed"),
    compact: () => setAtomikRail("compact"),
    expand: () => setAtomikRail("expanded"),
  };
}
