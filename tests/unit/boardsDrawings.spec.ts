import { test, expect } from "@playwright/test";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import { deleteDrawing } from "../../lib/production/boards";

/** Owner, 23 September: "give me the option to delete the line drawings". */
const drawing = (id: string): Asset => ({ id, uploadId: id, name: `${id}.png`, kind: "image", category: "Line drawing", url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
function project(): Project {
  return {
    ...newProject("Boards"), assets: [drawing("d1"), drawing("d2")], bins: [{ id: "b1", name: "Drawings", assetIds: ["d1", "d2"] }],
    production: { boards: { style: "live", model: "gemini-3.1-flash-image", frames: {
      "shot-1": { prompt: "A fox", sketch: { assetId: "d1", name: "d1.png" }, reading: "A fox, wide, left to right.", takes: [] },
      "shot-2": { prompt: "Mara", sketch: { assetId: "d2", name: "d2.png" }, takes: [] },
    } } },
  };
}

test("a deleted drawing leaves the project, its bin and its beat, with the agent's reading", () => {
  const after = deleteDrawing(project(), "d1");
  expect(after.assets.map((a) => a.id)).toEqual(["d2"]);
  expect(after.bins![0].assetIds).toEqual(["d2"]);
  expect(after.production!.boards!.frames["shot-1"]).toEqual({ prompt: "A fox", takes: [], sketch: undefined, reading: undefined, readingJobId: undefined });
  expect(after.production!.boards!.frames["shot-2"].sketch).toEqual({ assetId: "d2", name: "d2.png" });
});

test("a drawing the Rig uses is kept, and a missing one says so", () => {
  const used = { ...project(), nodes: [{ id: "m1", title: "Frame 1.1", type: "media" as const, x: 0, y: 0, width: 220, linked: [], assetId: "d1" }] };
  expect(() => deleteDrawing(used, "d1")).toThrow("input of “Frame 1.1” in the Rig");
  expect(() => deleteDrawing(project(), "nope")).toThrow("no longer in the project");
});

test("a drawing used in the cut, the edit's sound, Environment or Cast is kept, with where it is used", () => {
  const shot = { id: "s1", assetId: "d1", duration: 24, sourceIn: 0, name: "Shot 1" } as unknown as Project["shots"][number];
  expect(() => deleteDrawing({ ...project(), shots: [{ ...shot, assetId: "d2" }, shot] }, "d1")).toThrow("shot 2 of the cut");
  const clip = { id: "c1", assetId: "d1", lane: "sfx" as const, startFrame: 0, sourceIn: 0, duration: 1, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false };
  expect(() => deleteDrawing({ ...project(), audioClips: [clip] }, "d1")).toThrow("sound clip");
  const entry = { id: "e1", name: "Harbour", notes: "", prompt: "", references: ["d1"], plates: [] };
  const environment = { world: "", model: "gemini-3.1-flash-image" as const, entries: [entry] };
  expect(() => deleteDrawing({ ...project(), production: { ...project().production, environment } }, "d1")).toThrow("a reference of “Harbour” in Environment");
  const plated = { ...environment, entries: [{ ...entry, references: [], plates: [{ assetId: "d1", at: "", source: "library" as const }], selected: "d1" }] };
  expect(() => deleteDrawing({ ...project(), production: { ...project().production, environment: plated } }, "d1")).toThrow("a plate of “Harbour” in Environment");
  const cast = { entries: [{ id: "c1", name: "Mara", kind: "character" as const, description: "", prompt: "", referenceAssetId: "d1", takes: [] }] };
  expect(() => deleteDrawing({ ...project(), production: { ...project().production, cast } }, "d1")).toThrow("reference of “Mara” in Cast & Elements");
  // Unrelated uses of the other drawing do not block this one.
  const after = deleteDrawing({ ...project(), shots: [{ ...shot, assetId: "d2" }], production: { ...project().production, environment: { ...environment, entries: [{ ...entry, references: ["d2"] }] }, cast: { entries: [{ ...cast.entries[0], referenceAssetId: "d2" }] } } }, "d1");
  expect(after.assets.map((a) => a.id)).toEqual(["d2"]);
});
