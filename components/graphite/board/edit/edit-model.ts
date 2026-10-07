import { audioClips, type AudioClip } from "@/lib/workbench/audio";
import type { Project } from "@/lib/workbench/studio";
import { clock } from "../cards/take/take-model";
import type { CutData } from "../cards/cut/cut-model";

/*
 * Edit & Sound's timeline, from the edit's own data and nothing else (Gaps A frames, "Edit & Sound"). Pure: no React.
 *
 * - Picture is the edit's sequence in order: each clip with its start and length in frames, whether its take is approved, and
 *   whether it is trimmed (the clip starts after the start of its source).
 * - Voice, Music and Sound effects are the edit's three audio lanes (lib/workbench/audio.ts). A lane with nothing on it is
 *   drawn empty; the effects lane is drawn only when it holds something.
 * - Shots with no clip in the cut are not on the time scale (no length is claimed for them): they sit after the end of the cut
 *   as dashed blocks that say why they wait, in the Shots region's words.
 * - There is no captions lane: Cut can't show captions, so the screen offers none.
 */

export type PictureClip = { id: string; label: string; start: number; len: number; approved: boolean; trimmed: boolean };
export type SoundClip = { id: string; label: string; start: number; len: number; muted: boolean };
export type Lane = { id: AudioClip["lane"]; name: string; clips: SoundClip[] };
export type EditTimeline = {
  fps: number;
  /** The time scale, in frames: the cut's length, or further when sound runs on past it. */
  span: number;
  picture: PictureClip[];
  lanes: Lane[];
  waiting: { shot: number; word: string }[];
  /** Ruler marks, in seconds. */
  ticks: number[];
};

const LANES: { id: AudioClip["lane"]; name: string }[] = [
  { id: "dialogue", name: "Voice" }, { id: "music", name: "Music" }, { id: "sfx", name: "Sound effects" },
];

/** A tick every 1, 5, 10 or 30 s, whichever keeps the ruler to about six marks. */
export function rulerTicks(seconds: number): number[] {
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => seconds / s <= 6) ?? 60;
  const out: number[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += step) out.push(t);
  return out;
}

export function editTimeline(project: Project, cut: CutData): EditTimeline {
  const fps = Math.max(1, project.fps);
  const names = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a.name]));
  let at = 0;
  const picture: PictureClip[] = project.shots.map((s, i) => {
    const info = cut.clips[i];
    const start = at;
    at += s.duration;
    return { id: s.id, label: info?.label ?? s.name, start, len: s.duration, approved: info?.approved ?? false, trimmed: s.sourceIn > 0 };
  });
  const all = audioClips(project);
  const lanes: Lane[] = LANES.map((l) => ({
    id: l.id, name: l.name,
    clips: all.filter((c) => c.lane === l.id).sort((a, b) => a.startFrame - b.startFrame)
      .map((c) => ({ id: c.id, label: names.get(c.assetId) ?? "Missing source", start: c.startFrame, len: c.duration, muted: c.muted })),
  })).filter((l) => l.id !== "sfx" || l.clips.length);
  const audioEnd = Math.max(0, ...all.map((c) => c.startFrame + c.duration));
  const span = Math.max(1, at, audioEnd);
  return { fps, span, picture, lanes, waiting: cut.waiting, ticks: rulerTicks(span / fps) };
}

/** "0:04.88": a time in a clip as the trim rows show it. */
export function trimClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${String(Math.round((s - whole) * 100) % 100).padStart(2, "0")}`;
}

/** "00:00:04:00": hours, minutes, seconds, frames. */
export function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const total = Math.floor(f / fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}:${p(f % fps)}`;
}

export type Trim = { shotId: string; label: string; trimIn: number; trimOut: number; length: number };
/** The selected clip's trim rows, in seconds. */
export function trimOf(project: Project, cut: CutData, shotId: string | null): Trim | null {
  const index = project.shots.findIndex((s) => s.id === shotId);
  if (index < 0) return null;
  const s = project.shots[index], fps = Math.max(1, project.fps);
  return { shotId: s.id, label: cut.clips[index]?.label ?? s.name, trimIn: s.sourceIn / fps, trimOut: (s.sourceIn + s.duration) / fps, length: s.duration / fps };
}

/** "A 15-second film · 0:10 of 0:15 · 24 fps": the cut's length against what the production planned, when it planned one. */
export function editMeta(project: Project, cut: CutData, plannedSeconds: number | null): string {
  const total = plannedSeconds && plannedSeconds >= cut.seconds ? ` of ${clock(plannedSeconds)}` : "";
  return `${project.name} · ${clock(cut.seconds)}${total} · ${project.fps} fps`;
}

/** The length the production's plan gives its shots, in seconds, or null when it has no plan. */
export function plannedSeconds(project: Project): number | null {
  const scenes = project.production?.beats?.scenes;
  if (!scenes?.length) return null;
  const total = scenes.reduce((n, sc) => n + (sc.shots ?? []).reduce((m, sh) => m + (Number.isFinite(sh.duration) ? (sh.duration ?? 0) : 0), 0), 0);
  return total > 0 ? total : null;
}
