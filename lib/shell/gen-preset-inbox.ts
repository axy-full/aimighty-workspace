"use client";
import { useEffect } from "react";
import { GEN_PRESET_KEY, type GenPreset } from "./assets";

/**
 * A Gen preset sent from anywhere in the shell (⌘K's model rows). Gen reads a
 * preset from session storage when it mounts (components/graphite/GenView.tsx);
 * when Gen is already on screen nothing would mount again, so an open Gen
 * takes the preset directly instead of leaving it waiting for a later visit.
 */
const readers = new Set<(preset: GenPreset) => void>();

export function sendGenPreset(preset: GenPreset) {
  if (readers.size) { readers.forEach((read) => read(preset)); return; }
  try { sessionStorage.setItem(GEN_PRESET_KEY, JSON.stringify(preset)); } catch { /* Gen opens on its own choice; the pick is a convenience */ }
}

export function useGenPresetInbox(read: ((preset: GenPreset) => void) | null) {
  useEffect(() => {
    if (!read) return;
    readers.add(read);
    return () => { readers.delete(read); };
  }, [read]);
}
