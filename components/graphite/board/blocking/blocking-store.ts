"use client";
import { useSyncExternalStore } from "react";

/* Which shot's 3D blocking the board's full-screen overlay shows (null: closed). A tiny store, like the Edit & Sound one (cards/cut/edit-sound.ts). */
let open: { nodeId: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const openBlocking = (nodeId: string) => { if (open?.nodeId !== nodeId) { open = { nodeId }; emit(); } };
export const closeBlocking = () => { if (open) { open = null; emit(); } };
export function useOpenBlocking(): { nodeId: string } | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => null);
}
