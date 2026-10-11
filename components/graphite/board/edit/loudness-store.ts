"use client";
import { useCallback, useSyncExternalStore } from "react";
import { audioFingerprint } from "@/lib/workbench/audio";
import { DEFAULT_LOUDNESS_TARGET, targetOf, type LoudnessTarget, type LoudnessTargetId } from "@/lib/workbench/loudness";
import type { Project } from "@/lib/workbench/studio";
import type { LoudnessInput } from "../cards/deliver/spec-check";

/*
 * What Edit & Sound and the Deliver card share about loudness: the target chosen for this production's deliverable
 * (Broadcast or Web & social), and the last measurement of its mix. The target is a convenience kept on this device per
 * production (a failed read of storage falls back to Broadcast); the measurement lives for this visit only and counts
 * only while the sound it measured is what the cut still holds (the mix's own fingerprint), so a changed cut reads
 * "Not checked" again and never shows a figure for sound that is gone.
 */
export type Measured = { fingerprint: string; lufs: number | null; reduced: boolean };
type State = { target: LoudnessTargetId; measured: Measured | null };

const KEY = (projectId: string) => `particl-loudness-target:${projectId}`;
const states = new Map<string, State>();
const SERVER: State = { target: DEFAULT_LOUDNESS_TARGET, measured: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function read(projectId: string): State {
  let s = states.get(projectId);
  if (!s) {
    let target: LoudnessTargetId = DEFAULT_LOUDNESS_TARGET;
    try { target = targetOf(localStorage.getItem(KEY(projectId))).id; } catch { /* storage off: Broadcast */ }
    s = { target, measured: null };
    states.set(projectId, s);
  }
  return s;
}

export function setLoudnessTarget(projectId: string, target: LoudnessTargetId) {
  const was = read(projectId);
  if (was.target === target) return;
  states.set(projectId, { ...was, target });
  try { localStorage.setItem(KEY(projectId), target); } catch { /* kept for this visit */ }
  emit();
}
export function recordMeasured(projectId: string, measured: Measured) {
  states.set(projectId, { ...read(projectId), measured });
  emit();
}

export type LoudnessRead = { target: LoudnessTarget; /** The measurement of the sound the cut holds now, or null. */ measured: Measured | null };

/** The chosen target and the measurement that still holds for this project's sound. */
export function useLoudness(project: Project): LoudnessRead & { setTarget: (id: LoudnessTargetId) => void; record: (m: Measured) => void; fingerprint: string } {
  const subscribe = useCallback((l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const state = useSyncExternalStore(subscribe, () => read(project.id), () => SERVER);
  const fingerprint = audioFingerprint(project);
  const setTarget = useCallback((id: LoudnessTargetId) => setLoudnessTarget(project.id, id), [project.id]);
  const record = useCallback((m: Measured) => recordMeasured(project.id, m), [project.id]);
  return { target: targetOf(state.target), measured: state.measured && state.measured.fingerprint === fingerprint ? state.measured : null, setTarget, record, fingerprint };
}

/** The Deliver card's loudness row input: the deliverable's target and what the last check found, if it still holds. */
export function useLoudnessInput(project: Project): LoudnessInput {
  const { target, measured } = useLoudness(project);
  return { target, lufs: measured?.lufs ?? null, checked: measured != null };
}
