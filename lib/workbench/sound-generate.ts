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
/** The two sound tools of PR C2: a re-voiced track and a dubbed one, both from a stored original. */
export type SoundToolId = "voiceChange" | "dub";
export type SoundJobTask = NodeAudioTask | SoundToolId;
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
export type SoundToolDef = { id: SoundToolId; label: string; nodeTitle: string; endpoint: string; sources: Asset["kind"][] };
/** The tools, after the three generators: each one a door on an existing original. */
export const SOUND_TOOLS: SoundToolDef[] = [
  { id: "voiceChange", label: "Change voice", nodeTitle: "Voice change", endpoint: "/api/audio", sources: ["audio"] },
  { id: "dub", label: "Dub", nodeTitle: "Dub", endpoint: "/api/audio/dub", sources: ["audio", "video"] },
];
export const soundTool = (id: SoundToolId) => SOUND_TOOLS.find((t) => t.id === id) ?? SOUND_TOOLS[0];
export const isSoundTool = (id: SoundJobTask): id is SoundToolId => SOUND_TOOLS.some((t) => t.id === id);
export const soundJobLabel = (id: SoundJobTask) => (isSoundTool(id) ? soundTool(id).label : soundTask(id).label);

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

/** The lane's Rig node: one per task or tool, created on first use. Its takes are the
 *  generated tracks (v1, v2 …), which is how the library already lists sound. */
export const soundNodeRole = (task: SoundJobTask) => `sound-lane:${task}`;
export function findSoundNode(project: Project, task: SoundJobTask): CanvasNode | undefined {
  return project.nodes.find((n) => n.role === soundNodeRole(task) && !n.locked);
}
export function createSoundNode(project: Project, task: SoundJobTask): CanvasNode {
  const index = isSoundTool(task)
    ? SOUND_TASKS.length + SOUND_TOOLS.findIndex((t) => t.id === task)
    : SOUND_TASKS.findIndex((t) => t.id === task);
  return {
    id: uid("node"),
    type: "audio",
    mode: "Audio",
    role: soundNodeRole(task),
    title: isSoundTool(task) ? soundTool(task).nodeTitle : soundTask(task).nodeTitle,
    x: 40,
    y: 120 + Math.max(0, index) * 96 + (project.nodes.length % 3) * 12,
    width: 286,
    linked: [],
    collapsed: true,
  };
}

/** Stored originals a tool can take: the project's own and shared audio/video assets that name an upload or a generation. */
export function soundSources(project: Project, kinds: Asset["kind"][]): Asset[] {
  const seen = new Set<string>();
  return [...project.assets, ...(project.sharedAssets ?? [])].filter((a) => {
    if (!kinds.includes(a.kind) || (!a.uploadId && !a.generationId) || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
/** How the admission names a source: one stored upload or one generation, never a URL. */
export function soundSourceRef(asset: Asset): { sourceUploadId: string } | { sourceGenId: string } {
  if (asset.generationId) return { sourceGenId: asset.generationId };
  if (asset.uploadId) return { sourceUploadId: asset.uploadId };
  throw new Error("Choose a stored original: an upload or a generated take.");
}
/** The same payload is quoted and submitted through /api/audio as task voiceChange. */
export function voiceChangeBody(input: { source: Asset; voiceId: string; voiceName?: string; removeBackgroundNoise: boolean }) {
  return {
    task: "voiceChange" as const,
    ...soundSourceRef(input.source),
    voiceId: input.voiceId,
    ...(input.voiceName ? { voiceName: input.voiceName.slice(0, 80) } : {}),
    removeBackgroundNoise: Boolean(input.removeBackgroundNoise),
  };
}
/** The same payload is quoted and submitted through /api/audio/dub. */
export function dubBody(input: { source: Asset; sourceLang: string; targetLang: string; mode: string }) {
  return { ...soundSourceRef(input.source), sourceLang: input.sourceLang, targetLang: input.targetLang, mode: input.mode };
}
/** Dialogue clips playing the chosen source: what a voice change may replace in place. */
export function replaceableClips(project: Project, source: Asset): AudioClip[] {
  return audioClips(project).filter((c) => c.lane === "dialogue" && c.assetId === source.id);
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
  task: SoundJobTask;
  lane: SoundLane;
  startFrame: number;
  /** What was asked for, used when the file's own length cannot be read. */
  seconds: number;
  label: string;
  /** A voice change may take the place of the clip it was made from, keeping its timing. */
  replaceClipId?: string;
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
  if (placement.replaceClipId) {
    const index = clips.findIndex((c) => c.id === placement.replaceClipId);
    if (index >= 0) {
      const current = clips[index];
      if (current.assetId === asset.id) return project;
      // Same place, same length, same mix settings: only the voice changed.
      const replaced = clips.map((c, i) => (i === index ? { ...c, assetId: asset.id, sourceIn: 0 } : c));
      return { ...project, audioAssetId: undefined, audioClips: replaced };
    }
  }
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
