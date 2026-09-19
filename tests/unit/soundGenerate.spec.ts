import { test, expect } from "@playwright/test";
import { seedProject, type Asset } from "../../lib/workbench/studio";
import {
  SOUND_TASKS,
  SOUND_CLIP_LIMIT,
  clampSeconds,
  createSoundNode,
  expectedSeconds,
  findSoundNode,
  parseSoundPlacements,
  placeGeneratedClip,
  readSoundPlacements,
  soundGenerationBody,
  soundNodeRole,
  soundPlacementsKey,
  timecodeOf,
  writeSoundPlacements,
  SOUND_TOOLS,
  dubBody,
  isSoundTool,
  replaceableClips,
  soundJobLabel,
  soundSources,
  voiceChangeBody,
  type SoundPlacement,
} from "../../lib/workbench/sound-generate";
import { validateAudio } from "../../lib/workbench/audio";

/** The Edit & Sound rules the browser panel leans on, without a browser. */

const asset: Asset = {
  id: "gen-vo-1", generationId: "gen-vo-1", name: "Voice-over · v1", kind: "audio", category: "Shot", url: "/api/media/gen-vo-1",
  description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [],
};
const placement: SoundPlacement = { jobId: "gen-vo-1", task: "speech", lane: "dialogue", startFrame: 12, seconds: 3, label: "Voice-over" };

test("each task has one lane node, created on first use and found again afterwards", () => {
  const project = seedProject();
  expect(SOUND_TASKS.map((t) => [t.id, t.lane])).toEqual([["speech", "dialogue"], ["sound", "sfx"], ["music", "music"]]);
  expect(findSoundNode(project, "speech")).toBeUndefined();
  const node = createSoundNode(project, "speech");
  expect(node).toMatchObject({ type: "audio", mode: "Audio", role: soundNodeRole("speech"), title: "Voice-over", collapsed: true, linked: [] });
  const next = { ...project, nodes: [...project.nodes, node] };
  expect(findSoundNode(next, "speech")?.id).toBe(node.id);
  expect(findSoundNode(next, "music")).toBeUndefined();
  // A locked node is left alone; a fresh one is made beside it.
  expect(findSoundNode({ ...next, nodes: next.nodes.map((n) => (n.id === node.id ? { ...n, locked: true } : n)) }, "speech")).toBeUndefined();
});

test("the quoted body is the submitted body, in the audio admission's own shape", () => {
  const base = { text: "A line", seconds: 4, instrumental: true, promptInfluence: 1.4, voiceId: "voiceAAA01", modelId: "eleven_v3" };
  expect(soundGenerationBody({ ...base, task: "speech" })).toEqual({ task: "speech", text: "A line", voiceId: "voiceAAA01", modelId: "eleven_v3" });
  expect(soundGenerationBody({ ...base, task: "sound" })).toEqual({ task: "sound", text: "A line", durationSeconds: 4, promptInfluence: 1 });
  expect(soundGenerationBody({ ...base, task: "music" })).toEqual({ task: "music", text: "A line", lengthMs: 4000, instrumental: true });
  expect(clampSeconds("sound", 45)).toBe(30);
  expect(clampSeconds("sound", 0.1)).toBe(0.5);
  expect(clampSeconds("music", 5)).toBe(10);
  expect(clampSeconds("music", Number.NaN)).toBe(30);
  expect(expectedSeconds("speech", "a".repeat(46), 0)).toBe(4);
  expect(expectedSeconds("speech", " ", 0)).toBe(1);
  expect(expectedSeconds("sound", "", 2.5)).toBe(2.5);
  expect(expectedSeconds("music", "", 900)).toBe(300);
});

test("queued placements survive a reload and drop anything that cannot place a clip", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const key = soundPlacementsKey("scope-a", "project-1");
  expect(key).not.toBe(soundPlacementsKey("scope-b", "project-1"));
  writeSoundPlacements(storage, key, [placement]);
  expect(readSoundPlacements(storage, key)).toEqual([placement]);
  writeSoundPlacements(storage, key, []);
  expect(store.has(key)).toBe(false);
  expect(parseSoundPlacements("not json")).toEqual([]);
  expect(parseSoundPlacements(JSON.stringify([placement, { jobId: 1 }, { ...placement, lane: "voice" }, { ...placement, startFrame: -1 }, null]))).toEqual([placement]);
});

test("a finished asset becomes a clip on its lane at the playhead, within the edit's caps", () => {
  const project = { ...seedProject(), fps: 24, assets: [asset], audioClips: [] };
  const placed = placeGeneratedClip(project, placement, asset, 2.52);
  expect(placed.audioClips).toHaveLength(1);
  expect(placed.audioClips![0]).toMatchObject({ assetId: "gen-vo-1", lane: "dialogue", startFrame: 12, sourceIn: 0, duration: 60, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false });
  expect(() => validateAudio(placed)).not.toThrow();
  // The same arrival placed twice is one clip.
  expect(placeGeneratedClip(placed, placement, asset, 2.52)).toBe(placed);
  // A legacy soundtrack is carried into the explicit list rather than lost.
  const legacy = placeGeneratedClip({ ...project, audioAssetId: asset.id }, placement, asset, 1);
  expect(legacy.audioAssetId).toBeUndefined();
  expect(legacy.audioClips!.map((c) => c.lane)).toEqual(["music", "dialogue"]);
  // Never below one frame, never above the 64-clip edit.
  expect(placeGeneratedClip(project, placement, asset, 0.001).audioClips![0].duration).toBe(1);
  const full = { ...project, audioClips: Array.from({ length: SOUND_CLIP_LIMIT }, (_, i) => ({ ...placed.audioClips![0], id: "clip-" + i, assetId: "other-" + i, startFrame: i })) };
  expect(() => placeGeneratedClip(full, placement, asset, 1)).toThrow(/up to 64 audio clips/);
  expect(timecodeOf(12, 24)).toBe("00:00");
  expect(timecodeOf(24 * 61, 24)).toBe("01:01");
});

test("the two tools have their own lane nodes, take only stored originals, and a voice change can replace its clip in place", () => {
  expect(SOUND_TOOLS.map((t) => [t.id, t.endpoint, t.sources])).toEqual([
    ["voiceChange", "/api/audio", ["audio"]],
    ["dub", "/api/audio/dub", ["audio", "video"]],
  ]);
  expect(isSoundTool("dub")).toBe(true);
  expect(isSoundTool("speech")).toBe(false);
  expect(soundJobLabel("voiceChange")).toBe("Change voice");
  expect(soundJobLabel("music")).toBe("Music");
  const project = seedProject();
  const node = createSoundNode(project, "dub");
  expect(node).toMatchObject({ type: "audio", mode: "Audio", role: soundNodeRole("dub"), title: "Dub", collapsed: true });
  expect(findSoundNode({ ...project, nodes: [...project.nodes, node] }, "dub")?.id).toBe(node.id);
  expect(findSoundNode(project, "voiceChange")).toBeUndefined();
  // Sources: audio (and, for a dub, video) assets that name an upload or a generation; links and images never.
  const audio: Asset = { ...asset, id: "interview", generationId: undefined, uploadId: "up-1", name: "Interview.wav", seconds: 65 };
  const video: Asset = { ...asset, id: "hero", kind: "video", generationId: "gen-v", name: "Hero" };
  const loose: Asset = { ...asset, id: "loose", generationId: undefined, uploadId: undefined };
  const withSources = { ...project, assets: [...project.assets, audio, video, loose, asset], sharedAssets: [audio] };
  expect(soundSources(withSources, ["audio"]).map((a) => a.id)).toEqual(["interview", "gen-vo-1"]);
  expect(soundSources(withSources, ["audio", "video"]).map((a) => a.id)).toEqual(["interview", "hero", "gen-vo-1"]);
  expect(voiceChangeBody({ source: audio, voiceId: "voiceAAA01", voiceName: "Avery", removeBackgroundNoise: true })).toEqual({ task: "voiceChange", sourceUploadId: "up-1", voiceId: "voiceAAA01", voiceName: "Avery", removeBackgroundNoise: true });
  expect(voiceChangeBody({ source: asset, voiceId: "voiceAAA01", removeBackgroundNoise: false })).toEqual({ task: "voiceChange", sourceGenId: "gen-vo-1", voiceId: "voiceAAA01", removeBackgroundNoise: false });
  expect(dubBody({ source: video, sourceLang: "auto", targetLang: "es", mode: "v1" })).toEqual({ sourceGenId: "gen-v", sourceLang: "auto", targetLang: "es", mode: "v1" });
  expect(() => voiceChangeBody({ source: loose, voiceId: "voiceAAA01", removeBackgroundNoise: false })).toThrow(/stored original/);
  // Replacement keeps the clip's place, length and mix; only its source changes. Other lanes' clips are not offered.
  const clip = { id: "clip-1", assetId: "interview", lane: "dialogue" as const, startFrame: 6, sourceIn: 3, duration: 48, gainDb: -3, pan: 0.2, fadeIn: 2, fadeOut: 2, muted: false, solo: false };
  const edited = { ...withSources, audioClips: [clip, { ...clip, id: "clip-music", lane: "music" as const }] };
  expect(replaceableClips(edited, audio).map((c) => c.id)).toEqual(["clip-1"]);
  expect(replaceableClips(edited, video)).toEqual([]);
  const changed: Asset = { ...asset, id: "gen-vc-1", generationId: "gen-vc-1", name: "Interview · voice changed (Avery)" };
  const replaced = placeGeneratedClip({ ...edited, assets: [...edited.assets, changed] }, { ...placement, jobId: "gen-vc-1", task: "voiceChange", replaceClipId: "clip-1" }, changed, 65);
  expect(replaced.audioClips).toHaveLength(2);
  expect(replaced.audioClips![0]).toEqual({ ...clip, assetId: "gen-vc-1", sourceIn: 0 });
  expect(() => validateAudio(replaced)).not.toThrow();
  // Replacing twice is a no-op; a vanished clip falls back to adding one at the playhead.
  expect(placeGeneratedClip(replaced, { ...placement, jobId: "gen-vc-1", task: "voiceChange", replaceClipId: "clip-1" }, changed, 65)).toBe(replaced);
  const added = placeGeneratedClip({ ...edited, assets: [...edited.assets, changed] }, { ...placement, jobId: "gen-vc-1", task: "voiceChange", replaceClipId: "gone", startFrame: 30 }, changed, 65);
  expect(added.audioClips).toHaveLength(3);
  expect(added.audioClips![2]).toMatchObject({ assetId: "gen-vc-1", lane: "dialogue", startFrame: 30, duration: 65 * added.fps });
});

