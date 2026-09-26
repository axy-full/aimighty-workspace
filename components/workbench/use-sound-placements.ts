"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { audioClips } from "@/lib/workbench/audio";
import type { MediaJob } from "@/lib/workbench/job-recovery";
import {
  parseSoundPlacements,
  placeGeneratedClip,
  readSoundPlacements,
  soundPlacementsKey,
  timecodeOf,
  writeSoundPlacements,
  type SoundPlacement,
} from "@/lib/workbench/sound-generate";
import type { Project } from "@/lib/workbench/studio";

/* Local storage as an external store: the pending claim and the queued
   placements are read through it, so a reload or a second tab sees the same
   request and never spends twice. One set of listeners for the page, so the
   composer's write reaches the page's placer at once. */
const listeners = new Set<() => void>();
export const notifySoundStorage = () => listeners.forEach((listener) => listener());
export function subscribeSoundStorage(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
export function readSoundStorage(key: string | null): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
const noStore = () => "";

/* What the last landing said, per project: an open composer shows it in its
   own status line; with no composer open, the page is told instead. */
export type SoundLanding = { text: string; error: boolean };
const landings = new Map<string, SoundLanding>();
const composers = new Map<string, number>();
function publishLanding(key: string, landing: SoundLanding) {
  landings.set(key, landing);
  notifySoundStorage();
  return (composers.get(key) ?? 0) > 0;
}
const noLanding = () => null;
/** The latest landing message for this project (a new object each time one lands), for an open composer. */
export function useSoundLanding(key: string): SoundLanding | null {
  useEffect(() => {
    composers.set(key, (composers.get(key) ?? 0) + 1);
    return () => {
      const left = (composers.get(key) ?? 1) - 1;
      if (left) composers.set(key, left);
      else composers.delete(key);
    };
  }, [key]);
  return useSyncExternalStore(subscribeSoundStorage, () => landings.get(key) ?? null, noLanding);
}

/** The file's own length, read from its header; null when it cannot be read in time. */
function probeSeconds(url: string, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const el = document.createElement("audio");
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

/** The sound this project has queued for the timeline, and how to add to it. */
export function useSoundPlacementList(scope: string, projectId: string) {
  const key = soundPlacementsKey(scope, projectId);
  const raw = useSyncExternalStore(subscribeSoundStorage, () => readSoundStorage(key), noStore);
  const placements = useMemo(() => parseSoundPlacements(raw), [raw]);
  const remember = useCallback((next: SoundPlacement[]) => {
    writeSoundPlacements(window.localStorage, key, next);
    notifySoundStorage();
  }, [key]);
  return { key, placements, remember };
}

/**
 * Lands queued sound on its lane: when a generation's asset arrives it becomes
 * a clip at the remembered playhead, and a failed or cancelled job's placement
 * is cleared. Run once per page (Edit & Sound, the Studio), whether or not a
 * composer is open — SoundGenerate only records placements. What happened is
 * shown in an open composer, or passed to onPlaced / onFailed when none is.
 */
export function useSoundPlacements({ scope, project, jobs, onChange, onPause, onPlaced, onFailed }: {
  scope: string;
  project: Project;
  jobs: MediaJob[];
  onChange: (fn: (p: Project) => Project) => void;
  onPause: () => void;
  onPlaced: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const { key, placements, remember } = useSoundPlacementList(scope, project.id);
  const projectRef = useRef(project);
  const callbacks = useRef({ onChange, onPause, onPlaced, onFailed });
  const placing = useRef(new Set<string>());
  useLayoutEffect(() => {
    projectRef.current = project;
    callbacks.current = { onChange, onPause, onPlaced, onFailed };
  }, [project, onChange, onPause, onPlaced, onFailed]);

  /* A landing the page could not take yet (it was switching projects) is tried again shortly. */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!placements.length) return;
    const projectId = project.id;
    for (const placement of placements) {
      if (placing.current.has(placement.jobId)) continue;
      const asset = project.assets.find((a) => a.generationId === placement.jobId);
      if (asset) {
        placing.current.add(placement.jobId);
        void probeSeconds(asset.url).then((measured) => {
          /* The probe can take seconds; by then the page may show another project. That
             project's clips are not this one's: leave the placement queued for when it returns. */
          if (projectRef.current.id !== projectId) {
            placing.current.delete(placement.jobId);
            return;
          }
          let applied = false;
          try {
            callbacks.current.onPause();
            const replacing = placement.replaceClipId && audioClips(projectRef.current).some((c) => c.id === placement.replaceClipId);
            callbacks.current.onChange((p) => {
              if (p.id !== projectId) return p;
              applied = true;
              return placeGeneratedClip(p, placement, asset, measured ?? asset.seconds ?? placement.seconds);
            });
            if (!applied) {
              /* The page ignored the change (mid-switch): keep it queued and try again. */
              placing.current.delete(placement.jobId);
              setTimeout(() => setRetry((n) => n + 1), 1000);
              return;
            }
            const text = replacing
              ? `${placement.label} replaced its dialogue clip in place.`
              : `${placement.label} placed on the ${placement.lane === "sfx" ? "SFX" : placement.lane} lane at ${timecodeOf(placement.startFrame, projectRef.current.fps)}.`;
            if (!publishLanding(key, { text, error: false })) callbacks.current.onPlaced(text);
          } catch (e) {
            const text = e instanceof Error ? e.message : "The clip could not be placed.";
            if (!publishLanding(key, { text, error: true })) callbacks.current.onFailed(text);
          }
          remember(readSoundPlacements(window.localStorage, key).filter((p) => p.jobId !== placement.jobId));
          placing.current.delete(placement.jobId);
        });
        continue;
      }
      const job = jobs.find((j) => j.id === placement.jobId);
      if (job && (job.status === "failed" || job.status === "cancelled")) {
        const text = job.error || `${placement.label} did not finish. Nothing was placed.`;
        if (!publishLanding(key, { text, error: true })) callbacks.current.onFailed(text);
        remember(readSoundPlacements(window.localStorage, key).filter((p) => p.jobId !== placement.jobId));
      }
    }
  }, [placements, project.id, project.assets, jobs, remember, key, retry]);

  return placements;
}
