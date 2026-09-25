"use client";
import { useEffect } from "react";
import { GEN_PRESET_KEY, readGenPreset, type GenPreset } from "./assets";

/**
 * The letterbox between whatever hands Gen a preset (an asset's Retry
 * generation, Crew's Open in Gen, Soul ID's Use in Gen) and Gen's composer —
 * like reference-inbox.ts. A preset sent while Gen is on screen is applied at
 * once; one sent from elsewhere waits for Gen to open, and is applied then,
 * exactly once. Senders that still leave the preset in sessionStorage are
 * read the same way when Gen opens.
 */
let waiting: GenPreset | null = null;
const readers = new Set<(preset: GenPreset) => void>();

export function sendGenPreset(preset: GenPreset) {
  if (readers.size) readers.forEach((read) => read(preset));
  else waiting = preset;
}

export function useGenPresetInbox(read: ((preset: GenPreset) => void) | null) {
  useEffect(() => {
    if (!read) return;
    readers.add(read);
    let backlog = waiting;
    waiting = null;
    try {
      const stored = readGenPreset(sessionStorage.getItem(GEN_PRESET_KEY));
      if (stored) { sessionStorage.removeItem(GEN_PRESET_KEY); backlog ??= stored; }
    } catch { /* storage blocked: only the in-memory letter */ }
    if (backlog) read(backlog);
    return () => { readers.delete(read); };
  }, [read]);
}
