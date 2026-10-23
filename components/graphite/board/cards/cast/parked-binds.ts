import { useSyncExternalStore } from "react";
import type { PressedCard } from "./cast-model";

/*
 * A training's bind to its cast card, parked until its production is open again (review 3 of #888, R3-1).
 *
 * A training's reply can take minutes. If another production is open when it lands (or the board can't take the edit
 * then), the bind is parked here against the production it was pressed in, and the board applies it the next time that
 * production is open (BoardView), so its card follows the training and never offers Train again for it.
 *
 * This browser's own: in memory, mirrored to localStorage per workspace scope so a reload keeps it. A parked bind is a
 * card's pointer to an identity this person started; it carries no money, no consent and nothing anyone else reads.
 * Storage that is off (a private window) keeps it in memory for the tab.
 */
export type ParkedBind = PressedCard & { identityId: string; at: number };

const KEY = "particl-parked-identity-binds:";
/** A parked bind older than this is dropped: the production was not opened again in time, and the card's own list still shows it. */
const KEEP_MS = 30 * 86_400_000;
const memory = new Map<string, ParkedBind[]>();
const listeners = new Set<() => void>();
const NONE: ParkedBind[] = [];

function read(scope: string): ParkedBind[] {
  const held = memory.get(scope);
  if (held) return held;
  let stored: ParkedBind[] = [];
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY + scope);
    const parsed = raw ? JSON.parse(raw) : [];
    stored = Array.isArray(parsed) ? parsed.filter((p): p is ParkedBind => !!p && typeof p.projectId === "string" && typeof p.identityId === "string" && typeof p.at === "number") : [];
  } catch { /* storage off: memory only */ }
  memory.set(scope, stored);
  return stored;
}

function write(scope: string, all: ParkedBind[]): void {
  memory.set(scope, all);
  for (const l of listeners) l();
  try {
    if (typeof localStorage === "undefined") return;
    if (all.length) localStorage.setItem(KEY + scope, JSON.stringify(all));
    else localStorage.removeItem(KEY + scope);
  } catch { /* storage off: memory only */ }
}

/** Parks a bind for its production. The same identity is parked once. */
export function parkBind(scope: string, bind: Omit<ParkedBind, "at">, at = Date.now()): void {
  const kept = read(scope).filter((p) => p.identityId !== bind.identityId && at - p.at < KEEP_MS);
  write(scope, [...kept, { ...bind, at }]);
}

/** Drops one parked bind ("Not this card", or once it is attached). Returns it, for Undo. */
export function dropParked(scope: string, identityId: string): ParkedBind | null {
  const all = read(scope);
  const found = all.find((p) => p.identityId === identityId) ?? null;
  if (found) write(scope, all.filter((p) => p.identityId !== identityId));
  return found;
}

/** The binds parked in this workspace, as they are now (for the cards: a card with one says its training was started). */
export function useParked(scope: string | null): readonly ParkedBind[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (scope ? read(scope) : NONE),
    () => NONE,
  );
}

/** Takes (and removes) the binds parked for a production, oldest first, so the newest training binds last. */
export function takeParked(scope: string, projectId: string, at = Date.now()): ParkedBind[] {
  const all = read(scope).filter((p) => at - p.at < KEEP_MS);
  const mine = all.filter((p) => p.projectId === projectId).sort((a, b) => a.at - b.at);
  write(scope, all.filter((p) => p.projectId !== projectId));
  return mine;
}
