"use client";
import { useSyncExternalStore } from "react";

/*
 * Which transcript the board's side panel shows (gap screens, Transcribe). A tiny store, like the Edit & Sound one
 * (cards/cut/edit-sound.ts), so any card that has a transcript opens the one panel the board mounts.
 */
export type OpenTranscript = { slot: string; name: string };
let open: OpenTranscript | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const openTranscript = (next: OpenTranscript) => { if (open?.slot !== next.slot) { open = next; emit(); } };
export const closeTranscript = () => { if (open) { open = null; emit(); } };
export function useOpenTranscript(): OpenTranscript | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => null);
}
