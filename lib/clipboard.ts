"use client";

import { useSyncExternalStore } from "react";

/**
 * The app's clipboard (docs/change-request-1.md §10): one slot, five kinds
 * of thing — a shot, a take or other media, an asset, a canvas node, a
 * reference — cut or copied, pasted where the kind makes sense. Kept in
 * memory and mirrored to sessionStorage, so ⌘C on one page and ⌘V on
 * another works within the tab and never leaks to the next visitor.
 *
 * What a paste does is the target's decision (§10): a cut moves — takes and
 * cost go too; a copied shot pastes planning only (new ID, 0 cr); copied
 * media goes into the composer's reference well; a copied asset becomes a
 * new asset with nothing trained.
 */
export type ClipKind = "shot" | "media" | "asset" | "node" | "reference";
export type ClipMode = "cut" | "copy";
export type Clip = { kind: ClipKind; mode: ClipMode; id: string; label: string; payload?: unknown; at: number };

const KEY = "aw_clip";
let clip: Clip | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function readStored(): Clip | null {
  try { const raw = sessionStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Clip) : null; } catch { return null; }
}
if (typeof window !== "undefined") clip = readStored();

export function setClip(next: Omit<Clip, "at"> | null): void {
  clip = next ? { ...next, at: Date.now() } : null;
  try { if (clip) sessionStorage.setItem(KEY, JSON.stringify(clip)); else sessionStorage.removeItem(KEY); } catch { /* private mode */ }
  emit();
}
export const getClip = (): Clip | null => clip;
/** After a cut is pasted the slot empties; a copy can be pasted again. */
export function consumeClip(): Clip | null { const c = clip; if (c?.mode === "cut") setClip(null); return c; }

export function useClipboard(): Clip | null {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getClip, () => null);
}
