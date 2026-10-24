import { useSyncExternalStore } from "react";
import type { CastBinding, PressedCard } from "./cast-model";

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
/**
 * `attached`: the person attached it to the renamed card ("Attach to <name>"). It stays here, so that any undo of that
 * attach (the toast's Undo, Cmd/Ctrl+Z, or the binding changed by any other route) holds the training on the card again
 * rather than leaving "No identity yet" with Train for a training already sent (review 7 of #888, R7-2). It is held only
 * while the card is no longer bound to it, and is never applied by the board.
 */
export type ParkedBind = PressedCard & { identityId: string; at: number; attached?: boolean; was?: CastBinding; attachedName?: string };

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

/** An attached record takes its card's new name (renamed while attached, R9-2). Writes only when something changes. */
export function renameAttached(scope: string, identityId: string, attachedName: string): void {
  const all = read(scope);
  if (!all.some((p) => p.identityId === identityId && p.attached && p.attachedName !== attachedName)) return;
  write(scope, all.map((p) => (p.identityId === identityId && p.attached ? { ...p, attachedName } : p)));
}

/** Listens for changes to the parked binds (the cards re-read them); returns the unsubscribe. */
export function subscribeParked(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Drops the attached binds kept for a card once a newer training is bound to it: they have nothing left to guard. */
export function dropAttachedFor(scope: string, card: PressedCard, except: string): void {
  const all = read(scope);
  const keep = all.filter((p) => !(p.attached && p.projectId === card.projectId && p.identityId !== except
    && ((card.entryId != null && p.entryId === card.entryId) || (card.nodeId != null && p.nodeId === card.nodeId))));
  if (keep.length !== all.length) write(scope, keep);
}

/** The binds parked in this workspace, as they are now (for the cards: a card with one says its training was started). */
export function useParked(scope: string | null): readonly ParkedBind[] {
  return useSyncExternalStore(
    subscribeParked,
    () => (scope ? read(scope) : NONE),
    () => NONE,
  );
}

/**
 * Takes (and removes) the binds parked for a production that the board should try, oldest first, so the newest
 * training binds last. Attached ones stay. With nothing to take, nothing is written or announced (R7-3: a rename's
 * keystrokes don't rewrite storage or wake every cast card).
 */
export function takeParked(scope: string, projectId: string, at = Date.now()): ParkedBind[] {
  const stored = read(scope);
  const all = stored.filter((p) => at - p.at < KEEP_MS);
  const mine = all.filter((p) => p.projectId === projectId && !p.attached).sort((a, b) => a.at - b.at);
  if (!mine.length) { if (all.length !== stored.length) write(scope, all); return []; }
  write(scope, all.filter((p) => !(p.projectId === projectId && !p.attached)));
  return mine;
}

/**
 * Marks a held bind attached (R7-2), with the card's binding before the attach (`was`) and its name then (R8-1): the card
 * is held again only while its binding is exactly `was` again under that same name (the attach was undone).
 */
export function markAttached(scope: string, identityId: string, was: CastBinding, attachedName: string): void {
  const all = read(scope);
  if (!all.some((p) => p.identityId === identityId)) return;
  write(scope, all.map((p) => (p.identityId === identityId ? { ...p, attached: true, was, attachedName } : p)));
}
