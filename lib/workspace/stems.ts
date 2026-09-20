import { audioClips, type AudioClip } from "../workbench/audio";
import { findSoundNode, soundJobLabel, type SoundJobTask, type SoundPlacement } from "../workbench/sound-generate";
import type { Project } from "../workbench/studio";

/**
 * Edit & Sound's stem rows, derived from the edit's real audio lanes
 * (lib/workbench/audio.ts: dialogue, music, sfx).
 *
 * AMBIENCE: the design shows four stems; the edit has three lanes. Ambience
 * beds are generated with the sound-effects engine and placed on the sfx
 * lane, so they are counted there. No fourth lane is invented.
 */

export type StemId = AudioClip["lane"];
export type StemState = "empty" | "generating" | "scored";

export type StemDef = {
  id: StemId;
  name: string;
  /** The capability, never a vendor. */
  engine: string;
  /** The SoundGenerate door the row opens. */
  task: SoundJobTask;
  hue: string;
  empty: string;
};

export const STEMS: StemDef[] = [
  { id: "dialogue", name: "Dialogue", engine: "Voice", task: "speech", hue: "#2E2E34", empty: "No spoken lines in the cut yet." },
  { id: "sfx", name: "Sound effects", engine: "Sound effects", task: "sound", hue: "#0A84FF", empty: "No effects or ambience beds in the cut yet." },
  { id: "music", name: "Music score", engine: "Music", task: "music", hue: "#E0B95E", empty: "No score in the cut yet." },
];

export type StemRow = StemDef & {
  state: StemState;
  clips: AudioClip[];
  /** Clip names on the lane, in timeline order. */
  names: string[];
  seconds: number;
  pending: number;
  /** Generate, or Add for an empty dialogue lane, or Replace where a tool replaces in place. */
  action: { label: "Add" | "Generate" | "Replace"; task: SoundJobTask };
};

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Placements are the queued generations SoundGenerate remembers (sound-generate.ts). */
export function stemRows(project: Project, placements: readonly SoundPlacement[] = []): StemRow[] {
  const clips = audioClips(project);
  const names = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a.name]));
  return STEMS.map((def) => {
    const own = clips.filter((c) => c.lane === def.id).sort((a, b) => a.startFrame - b.startFrame);
    const pending = placements.filter((p) => p.lane === def.id).length;
    const state: StemState = pending ? "generating" : own.length ? "scored" : "empty";
    /* Only dialogue has a tool that replaces a clip in place (Change voice). */
    const action: StemRow["action"] = def.id === "dialogue"
      ? own.length ? { label: "Replace", task: "voiceChange" } : { label: "Add", task: "speech" }
      : { label: "Generate", task: def.task };
    return {
      ...def, state, clips: own, pending, action,
      names: own.map((c) => names.get(c.assetId) ?? "Missing source"),
      seconds: own.reduce((n, c) => n + c.duration, 0) / Math.max(1, project.fps),
    };
  });
}

/** The sequence clip under `frame`, and the frame it starts on (Studio's currentShot). */
export function shotAt(shots: Project["shots"], frame: number) {
  let at = 0;
  for (const shot of shots) {
    if (frame < at + shot.duration) return { shot, start: at };
    at += shot.duration;
  }
  const last = shots[shots.length - 1];
  return last ? { shot: last, start: Math.max(0, at - last.duration) } : null;
}

/** The assembly: the edit sequence's own length and clip count. */
export function assembly(project: Project) {
  const frames = project.shots.reduce((n, s) => n + s.duration, 0);
  return { clips: project.shots.length, frames, seconds: frames / Math.max(1, project.fps) };
}

/**
 * The Edit & Sound plan's request (PlanRequest.stems): for each stem whose
 * form is complete, the same body SoundGenerate submits — its admission body
 * plus the lane node's production shot and title — without maxCredits,
 * which the plan adds from the approved quote. A stem whose lane node has
 * not been mapped to a production shot yet is left out rather than guessed.
 */
export function stemRequests(
  project: Project,
  composed: Partial<Record<StemId, { task: SoundJobTask; body: Record<string, unknown>; text: string } | null>>,
): { name: string; body: Record<string, unknown>; route: "/api/audio" | "/api/audio/dub" }[] {
  return STEMS.flatMap((def) => {
    const form = composed[def.id];
    if (!form || !project.productionProjectId) return [];
    const node = findSoundNode(project, form.task);
    const shotId = node ? project.shotMappings?.[node.id] : undefined;
    if (!shotId) return [];
    return [{
      name: def.name,
      route: form.task === "dub" ? ("/api/audio/dub" as const) : ("/api/audio" as const),
      body: { ...form.body, projectId: project.productionProjectId, shotId, title: `${soundJobLabel(form.task)} · ${form.text.slice(0, 60)}` },
    }];
  });
}
