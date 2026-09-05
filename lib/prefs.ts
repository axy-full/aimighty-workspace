"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_MODEL_ID, getModel } from "./models";

/**
 * What the composer should already be set to when you open it. Per browser,
 * because it's a working preference rather than a workspace policy — two
 * people on the same team can prefer different defaults without arguing.
 */
export type Prefs = { modelId: string; resolution: string; duration: number; audio: boolean };

const KEY = "aw_prefs";
const FALLBACK: Prefs = { modelId: DEFAULT_MODEL_ID, resolution: "1080p", duration: 5, audio: false };

const listeners = new Set<() => void>();
let snapshot: Prefs | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}

function read(): Prefs {
  if (snapshot) return snapshot;
  let value = FALLBACK;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      const model = getModel(p.modelId ?? FALLBACK.modelId);
      value = {
        modelId: model.id,
        resolution: model.resolutions.includes(p.resolution ?? "")
          ? p.resolution! : model.resolutions[model.resolutions.length - 1],
        duration: model.durations.includes(Number(p.duration))
          ? Number(p.duration) : (model.durations[0] ?? Number(p.duration)) || FALLBACK.duration,
        audio: Boolean(p.audio),
      };
    }
  } catch { /* a corrupt or unknown preference is just a default */ }
  // useSyncExternalStore demands a stable reference between changes.
  snapshot = value;
  return value;
}

export function setPrefs(next: Partial<Prefs>): void {
  const merged = { ...read(), ...next };
  snapshot = merged;
  try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, read, () => FALLBACK);
}
