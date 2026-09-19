import { audioClips, type AudioClip } from "./audio";
import { nodeAudioBody, type NodeAudioTask } from "./generation-audio";
import { uid, type Asset, type CanvasNode, type Project } from "./studio";

/**
 * Edit & Sound: generating straight into the timeline lanes.
 *
 * Everything here is pure so the browser panel stays thin and the rules are
 * unit-tested: which Rig node a generation is filed under, how a queued
 * generation remembers where it belongs, and how the finished asset becomes
 * a clip at the playhead without breaking the edit's caps.
 */

export type SoundLane = AudioClip["lane"];
export type SoundTaskDef = {
  id: NodeAudioTask;
  label: string;
  lane: SoundLane;
  /** What the person writes: a line to read, or a description. */
  field: string;
  nodeTitle: string;
};

/** The three doors the Edit panel opens, in the order they are shown. */
export const SOUND_TASKS: SoundTaskDef[] = [
  { id: "speech", label: "Voice-over", lane: "dialogue", field: "Script", nodeTitle: "Voice-over" },
  { id: "sound", label: "Sound effect", lane: "sfx", field: "Describe the sound", nodeTitle: "Sound effects" },
  { id: "music", label: "Music", lane: "music", field: "Describe the music", nodeTitle: "Music" },
];
export const soundTask = (id: NodeAudioTask) => SOUND_TASKS.find((t) => t.id === id) ?? SOUND_TASKS[0];

/** Duration bounds per task, in seconds: the vendor's own limits. */
export const SOUND_SECONDS: Record<NodeAudioTask, { min: number; max: number; step: number; initial: number }> = {
  speech: { min: 0, max: 0, step: 1, initial: 0 },
  sound: { min: 0.5, max: 30, step: 0.5, initial: 5 },
  music: { min: 10, max: 300, step: 1, initial: 30 },
};
export function clampSeconds(task: NodeAudioTask, value: number): number {
  const b = SOUND_SECONDS[task];
  if (!Number.isFinite(value)) return b.initial;
  return Math.max(b.min, Math.min(b.max, value));
}

/** The lane's Rig node: one per task, created on first use. Its takes are the
 *  generated tracks (v1, v2 …), which is how the library already lists sound. */
export const soundNodeRole = (task: NodeAudioTask) => `sound-lane:${task}`;
export function findSoundNode(project: Project, task: NodeAudioTask): CanvasNode | undefined {
  return project.nodes.find((n) => n.role === soundNodeRole(task) && !n.locked);
}
export function createSoundNode(project: Project, task: NodeAudioTask): CanvasNode {
  const index = SOUND_TASKS.findIndex((t) => t.id === task);
  return {
    id: uid("node"),
    type: "audio",
    mode: "Audio",
    role: soundNodeRole(task),
    title: soundTask(task).nodeTitle,
    x: 40,
    y: 120 + Math.max(0, index) * 96 + (project.nodes.length % 3) * 12,
    width: 286,
    linked: [],
    collapsed: true,
  };
}

/** The same payload is quoted and submitted through the existing audio admission. */
export function soundGenerationBody(input: {
  task: NodeAudioTask;
  text: string;
  seconds: number;
  instrumental: boolean;
  promptInfluence: number;
  voiceId: string;
  modelId: string;
}) {
  const base = nodeAudioBody({
    task: input.task,
    text: input.text,
    seconds: input.seconds,
    instrumental: input.instrumental,
    voiceId: input.voiceId,
    modelId: input.modelId,
  });
  return input.task === "sound"
    ? { ...base, promptInfluence: Math.max(0, Math.min(1, input.promptInfluence)) }
    : base;
}

/** A queued generation and where it lands once its bytes exist. */
export type SoundPlacement = {
  jobId: string;
  task: NodeAudioTask;
  lane: SoundLane;
  startFrame: number;
  /** What was asked for, used when the file's own length cannot be read. */
  seconds: number;
  label: string;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export const soundPlacementsKey = (scope: string, projectId: string) =>
  `particl:sound-placements:${JSON.stringify([scope, projectId])}`;
export function readSoundPlacements(storage: Storage, key: string): SoundPlacement[] {
  try {
    return parseSoundPlacements(storage.getItem(key));
  } catch {
    return [];
  }
}
/** Whatever was stored, minus anything that could not place a clip. */
export function parseSoundPlacements(raw: string | null): SoundPlacement[] {
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter(
          (p): p is SoundPlacement =>
            !!p && typeof p === "object" && typeof (p as SoundPlacement).jobId === "string" &&
            ["dialogue", "music", "sfx"].includes((p as SoundPlacement).lane) &&
            Number.isSafeInteger((p as SoundPlacement).startFrame) && (p as SoundPlacement).startFrame >= 0,
        )
      : [];
  } catch {
    return [];
  }
}
export function writeSoundPlacements(storage: Storage, key: string, list: SoundPlacement[]) {
  try {
    if (list.length) storage.setItem(key, JSON.stringify(list));
    else storage.removeItem(key);
  } catch {
    /* Placement memory is a convenience; the asset still arrives in the library. */
  }
}

/** A read at about 15 characters a second; the file's own length wins when it can be read. */
export function expectedSeconds(task: NodeAudioTask, text: string, seconds: number): number {
  if (task === "speech") return Math.max(1, Math.ceil(text.trim().length / 15));
  return clampSeconds(task, seconds);
}

export const SOUND_CLIP_LIMIT = 64;

/** The finished asset becomes a clip on its lane at the remembered playhead. */
export function placeGeneratedClip(
  project: Project,
  placement: SoundPlacement,
  asset: Asset,
  seconds: number,
): Project {
  const clips = audioClips(project);
  if (clips.some((c) => c.assetId === asset.id && c.startFrame === placement.startFrame && c.lane === placement.lane))
    return project;
  if (clips.length >= SOUND_CLIP_LIMIT)
    throw new Error(`An edit supports up to ${SOUND_CLIP_LIMIT} audio clips. Remove one before placing ${placement.label}.`);
  const duration = Math.max(1, Math.min(216000, Math.round(seconds * project.fps)));
  const clip: AudioClip = {
    id: uid("audio"),
    assetId: asset.id,
    lane: placement.lane,
    startFrame: Math.min(21600000, placement.startFrame),
    sourceIn: 0,
    duration,
    gainDb: 0,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    solo: false,
  };
  return { ...project, audioAssetId: undefined, audioClips: [...clips, clip] };
}

export function timecodeOf(frame: number, fps: number): string {
  const s = Math.floor(frame / Math.max(1, fps));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
