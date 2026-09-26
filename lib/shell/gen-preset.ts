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

/**
 * A preset handed over across a page load — the public site's hero, before
 * sign-in — waits in this tab's session storage until Gen first reads
 * presets. Only the words, engine, kind, note and settings are taken from it.
 */
export const GEN_PRESET_STASH = "particl-gen-preset";
export function stashGenPreset(preset: GenPreset) {
  try { sessionStorage.setItem(GEN_PRESET_STASH, JSON.stringify(preset)); } catch { /* Gen then opens on its own choice */ }
}
function takeStashed(): GenPreset | null {
  try {
    const raw = sessionStorage.getItem(GEN_PRESET_STASH);
    if (!raw) return null;
    sessionStorage.removeItem(GEN_PRESET_STASH);
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== "object" || typeof p.prompt !== "string") return null;
    const type = p.type === "image" || p.type === "video" || p.type === "audio" ? p.type : undefined;
    const q = p.picks && typeof p.picks === "object" ? p.picks as Record<string, unknown> : {};
    const picks = {
      ...(typeof q.ratio === "string" ? { ratio: q.ratio } : {}),
      ...(typeof q.resolution === "string" ? { resolution: q.resolution } : {}),
      ...(typeof q.duration === "number" && q.duration > 0 ? { duration: q.duration } : {}),
    };
    return {
      prompt: p.prompt.slice(0, 20_000),
      ...(typeof p.model === "string" ? { model: p.model } : {}),
      ...(type ? { type } : {}),
      ...(typeof p.note === "string" ? { note: p.note.slice(0, 200) } : {}),
      ...(Object.keys(picks).length ? { picks } : {}),
    };
  } catch { return null; }
}

export function sendGenPreset(preset: GenPreset) {
  if (readers.size) { waiting = null; readers.forEach((read) => read(preset)); }
  else waiting = preset;
}

/** Start reading presets; the one waiting, if any, is delivered at once. Returns the stop. */
export function readGenPresets(read: (preset: GenPreset) => void): () => void {
  readers.add(read);
  const backlog = waiting ?? takeStashed();
  waiting = null;
  if (backlog) read(backlog);
  return () => { readers.delete(read); };
}

export function useGenPresetInbox(read: ((preset: GenPreset) => void) | null) {
  useEffect(() => (read ? readGenPresets(read) : undefined), [read]);
}
