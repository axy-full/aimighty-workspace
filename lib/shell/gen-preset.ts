"use client";
import { useEffect } from "react";
import type { GenPreset } from "./assets";

/**
 * Gen's letterbox for a preset (an asset's Retry generation, Soul ID's Use in
 * Gen, Crew's Open in Gen), like the reference inbox beside it: the mounted
 * Gen view applies a preset the moment it is sent — so a Retry pressed on Gen
 * itself lands at once — and one sent from another page waits, the newest
 * only, until Gen mounts. Nothing lingers to overwrite the composer later.
 */
let waiting: GenPreset | null = null;
const readers = new Set<(preset: GenPreset) => void>();

export function sendGenPreset(preset: GenPreset) {
  if (readers.size) { waiting = null; readers.forEach((read) => read(preset)); }
  else waiting = preset;
}

/** Start reading presets; the one waiting, if any, is delivered at once. Returns the stop. */
export function readGenPresets(read: (preset: GenPreset) => void): () => void {
  readers.add(read);
  const backlog = waiting;
  waiting = null;
  if (backlog) read(backlog);
  return () => { readers.delete(read); };
}

export function useGenPresetInbox(read: ((preset: GenPreset) => void) | null) {
  useEffect(() => (read ? readGenPresets(read) : undefined), [read]);
}
