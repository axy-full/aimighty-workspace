"use client";
import { useSyncExternalStore } from "react";

/*
 * Whether the existing Edit & Sound editor is open over the board (README § 3.1 frame i: "Open Edit & Sound"). A
 * tiny store so the Cut card, its Inspector and ⌘K-style callers open the one host the Inspector mounts.
 */
let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const openEditSound = () => { if (!open) { open = true; emit(); } };
export const closeEditSound = () => { if (open) { open = false; emit(); } };
export function useEditSoundOpen(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => false);
}
