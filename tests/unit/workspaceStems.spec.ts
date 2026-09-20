import { test, expect } from "@playwright/test";
import { assembly, mmss, shotAt, stemRequests, stemRows } from "../../lib/workspace/stems";
import { newProject, type Project } from "../../lib/workbench/studio";
import { soundNodeRole } from "../../lib/workbench/sound-generate";

const clip = (id: string, assetId: string, lane: "dialogue" | "music" | "sfx", startFrame: number, duration: number) =>
  ({ id, assetId, lane, startFrame, sourceIn: 0, duration, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false });
const audio = (id: string) => ({ id, name: `${id}.wav`, kind: "audio" as const, category: "Audio", url: "", description: "", prompt: "", status: "Draft" as const, locked: false, version: 1, refs: [] });

const project: Project = {
  ...newProject("P"), fps: 24, productionProjectId: "prod",
  assets: [audio("a"), audio("b"), audio("c")],
  shots: [{ id: "x", name: "X", assetId: "a", duration: 48, sourceIn: 0, note: "" }, { id: "y", name: "Y", assetId: "b", duration: 24, sourceIn: 12, note: "" }],
  audioClips: [clip("c2", "b", "dialogue", 30, 24), clip("c1", "a", "dialogue", 0, 24), clip("m", "c", "music", 0, 72)],
  nodes: [{ id: "node-sfx", title: "Sound effects", type: "audio", role: soundNodeRole("sound"), x: 0, y: 0, width: 200, linked: [] }],
  shotMappings: { "node-sfx": "shot_sfx" },
};

test("stems come from the three real lanes; ambience is not a lane", () => {
  const rows = stemRows(project, [{ jobId: "j", task: "sound", lane: "sfx", startFrame: 0, seconds: 5, label: "Sound effect" }]);
  expect(rows.map((r) => [r.id, r.state, r.action.label, r.action.task])).toEqual([
    ["dialogue", "scored", "Replace", "voiceChange"],
    ["sfx", "generating", "Generate", "sound"],
    ["music", "scored", "Generate", "music"],
  ]);
  expect(rows[0].names).toEqual(["a.wav", "b.wav"]);
  expect(rows[0].seconds).toBe(2);
  expect(stemRows({ ...project, audioClips: [] })[0].action).toEqual({ label: "Add", task: "speech" });
});

test("assembly length, timecode and the clip under the playhead", () => {
  expect(assembly(project)).toEqual({ clips: 2, frames: 72, seconds: 3 });
  expect(mmss(34.4)).toBe("00:34");
  expect(shotAt(project.shots, 50)).toEqual({ shot: project.shots[1], start: 48 });
  expect(shotAt(project.shots, 999)?.shot.id).toBe("y");
  expect(shotAt([], 0)).toBeNull();
});

test("the plan's stem bodies are SoundGenerate's, mapped to the lane's shot, never guessed", () => {
  const body = { task: "sound", text: "Wind", durationSeconds: 5, promptInfluence: 0.3 };
  expect(stemRequests(project, { sfx: { task: "sound", body, text: "Wind" }, music: { task: "music", body: { task: "music" }, text: "Piano" } })).toEqual([
    { name: "Sound effects", route: "/api/audio", body: { ...body, projectId: "prod", shotId: "shot_sfx", title: "Sound effect · Wind" } },
  ]);
  expect(stemRequests({ ...project, productionProjectId: undefined }, { sfx: { task: "sound", body, text: "Wind" } })).toEqual([]);
});
