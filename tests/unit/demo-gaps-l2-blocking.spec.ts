import { test, expect } from "@playwright/test";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import {
  BLOCKING_CATEGORY, BLOCKING_INPUT_PREFIX, LENSES, addFigure, addProp, blockingOf, cameraView, moveAt, moveEnd, moveWords, roleOf, sceneFromShot, shotSource, hasStaleBlockingInputs, tidyBlockingInputs, withBlockingFrame, withCameraView, withLens,
  type Move,
} from "../../lib/production/blocking";
import type { BeatSheet } from "../../lib/production/beats";

/*
 * 3D blocking (gap screens): the scene it builds from a shot, the camera in a director's words, the move, the frame saved to a shot,
 * and the one new optional field `production.blocking`: additive, so a project saved before it parses exactly as it did.
 * Neutral names only.
 */
const beats = (): BeatSheet => ({
  scriptSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", updatedAt: "2026-10-06T10:00:00.000Z",
  scenes: [{
    id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: ["Runner", "Guide"], locations: ["Hillside"], props: ["Lantern"],
    shots: [
      { id: "shot-a1", description: "A runner crests the hill.", framing: "Close-up", movement: "Slow push · 85mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a2", description: "Fog lifts.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "" },
    ],
  }],
});
const node = (id: string, boardShotId: string): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], boardShotId } as CanvasNode);
const project = (): Project => ({ ...newProject("Blocking fixture"), nodes: [node("node-shot1", "shot-a1"), node("node-shot2", "shot-a2")], production: { beats: beats() } });
const frame = (id: string): Asset => ({ id, uploadId: `up-${id}`, name: "Shot 1 · 3D blocking", kind: "image", category: BLOCKING_CATEGORY, url: `/api/uploads/up-${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });

test("a shot's words make the scene: a figure for each character, a prop for each prop, the place, a sun, the lens and the move", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  expect(scene.objects.map((o) => [o.name, roleOf(o)])).toEqual([["Hillside", "set"], ["Runner", "figure"], ["Guide", "figure"], ["Lantern", "prop"]]);
  expect(scene.lights.map((l) => l.name)).toEqual(["Sun"]);
  expect(scene.camera.focalLength).toBe(85);
  expect(move).toEqual({ kind: "push", meters: 1.2, seconds: 5 });
  expect(shotSource(project(), "node-shot1")?.characters).toEqual(["Runner", "Guide"]);
  const wide = sceneFromShot(project(), "node-shot2");
  expect(wide.scene.camera.focalLength).toBe(24);
  expect(wide.move.kind).toBe("hold");
  expect(wide.scene.camera.position[1]).toBeLessThan(sceneFromShot(project(), "node-shot1").scene.camera.position[1]);
  /* A shot with no beat sheet still gets a ground and a camera, and no invented name. */
  const bare = sceneFromShot({ ...project(), production: undefined }, "node-shot1");
  expect(bare.scene.objects.map((o) => o.name)).toEqual(["Ground"]);
  expect(LENSES).toContain(bare.scene.camera.focalLength);
});

test("the camera reads and moves in a director's words: position, height, tilt and lens", () => {
  const { scene } = sceneFromShot(project(), "node-shot1");
  const view = cameraView(scene);
  expect(view).toMatchObject({ x: 0, height: 1.6, lens: 85 });
  const moved = withCameraView(scene, { x: 2.4, height: 2 });
  expect(cameraView(moved)).toMatchObject({ x: 2.4, height: 2 });
  expect(cameraView(moved).tilt).toBeCloseTo(view.tilt, 0);
  const tipped = withCameraView(scene, { tilt: 10 });
  expect(cameraView(tipped).tilt).toBeCloseTo(10, 0);
  expect(cameraView(tipped).depth).toBe(view.depth);
  expect(withLens(scene, 50).camera.focalLength).toBe(50);
});

test("a push goes toward what the camera looks at, a pull away, a hold nowhere; playing it is a straight line between", () => {
  const { scene } = sceneFromShot(project(), "node-shot1");
  const start = scene.camera.position;
  const push = moveEnd(scene, { kind: "push", meters: 1.2, seconds: 5 });
  expect(push.position[1]).toBeGreaterThan(start[1]);
  expect(Math.hypot(push.target[0] - push.position[0], push.target[1] - push.position[1], push.target[2] - push.position[2])).toBeCloseTo(Math.hypot(scene.camera.target[0] - start[0], scene.camera.target[1] - start[1], scene.camera.target[2] - start[2]), 5);
  expect(moveEnd(scene, { kind: "pull", meters: 2, seconds: 5 }).position[1]).toBeLessThan(start[1]);
  expect(moveEnd(scene, { kind: "hold", meters: 0, seconds: 5 })).toEqual(scene.camera);
  const move: Move = { kind: "push", meters: 1.2, seconds: 5 };
  expect(moveAt(scene, move, 0).position).toEqual(start);
  expect(moveAt(scene, move, 1).position).toEqual(push.position);
  expect(moveAt(scene, move, 0.5).position[1]).toBeCloseTo((start[1] + push.position[1]) / 2, 6);
  expect(moveAt(scene, move, 7).position).toEqual(push.position);
  expect(moveWords(move)).toBe("Slow push · 1.2 m");
  expect(moveWords({ kind: "hold", meters: 0, seconds: 5 })).toBe("Held");
});

test("a figure and a prop are added with their own marks, never over each other", () => {
  let scene = sceneFromShot(project(), "node-shot1").scene;
  const before = scene.objects.length;
  scene = addFigure(addProp(scene));
  expect(scene.objects).toHaveLength(before + 2);
  expect(new Set(scene.objects.map((o) => o.id)).size).toBe(scene.objects.length);
  expect(scene.objects.at(-1)!.name).toMatch(/^Figure \d+$/);
});

test("saving a frame files it as the shot's input, keeps the scene, and a second save replaces the first frame", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  const entry = { scene, move, savedAt: "2026-10-06T10:20:00.000Z" };
  const once = withBlockingFrame(project(), "node-shot1", entry, frame("f1"), "Shot 1 · 3D blocking");
  expect(blockingOf(once, "node-shot1")).toMatchObject({ frameAssetId: "f1", move });
  expect(once.nodes.find((n) => n.id === "node-shot1")!.linked).toHaveLength(1);
  expect(once.assets.map((a) => a.id)).toEqual(["f1"]);
  const twice = withBlockingFrame(once, "node-shot1", { ...entry, savedAt: "2026-10-06T11:00:00.000Z" }, frame("f2"), "Shot 1 · 3D blocking");
  const shot = twice.nodes.find((n) => n.id === "node-shot1")!;
  expect(shot.linked).toHaveLength(1);
  expect(twice.nodes.find((n) => n.id === shot.linked[0])!.assetId).toBe("f2");
  expect(blockingOf(twice, "node-shot1")!.frameAssetId).toBe("f2");
  /* Another shot's blocking is not touched. */
  expect(blockingOf(twice, "node-shot2")).toBeNull();
  /* A locked shot refuses, in rig-build's words, and the project is as it was. */
  const locked = { ...project(), nodes: project().nodes.map((n) => (n.id === "node-shot1" ? { ...n, locked: true } : n)) };
  expect(() => withBlockingFrame(locked, "node-shot1", entry, frame("f3"), "Shot 1 · 3D blocking")).toThrow("Unlock this shot");
});

test("a project with more than 200 blocked shots still saves; the 201st is not a lock-out", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  const entry = { scene, move, savedAt: "2026-10-06T10:20:00.000Z" };
  const nodes = Array.from({ length: 260 }, (_, i) => node(`node-s${i}`, "shot-a1"));
  const blocking = Object.fromEntries(nodes.slice(0, 250).map((n) => [n.id, entry]));
  const big: Project = { ...project(), nodes, production: { beats: beats(), blocking } };
  const saved = withBlockingFrame(big, "node-s255", entry, frame("fx"), "Shot 256 · 3D blocking");
  expect(Object.keys(saved.production!.blocking!)).toHaveLength(251);
  expect(projectSchema.safeParse(saved).success).toBe(true);
});

test("a record the server would refuse is refused in words before it is applied, and the project is left as it was so later saves still work", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  const entry = { scene, move, savedAt: "2026-10-06T10:20:00.000Z" };
  const odd = { ...project(), nodes: [...project().nodes, node("node shot", "shot-a1")] };
  let said = "";
  try { withBlockingFrame(odd, "node shot", entry, frame("f1"), "Shot 3 · 3D blocking"); } catch (error) { said = (error as Error).message; }
  expect(said).toContain("This shot cannot hold 3D blocking");
  expect(said).not.toMatch(/Invalid input|Too small|expected/);
  /* Nothing changed: the project parses and saves exactly as before. */
  expect(projectSchema.safeParse(odd).success).toBe(true);
  expect(blockingOf(odd, "node shot")).toBeNull();
  /* A bad move, held by the same check. */
  expect(() => withBlockingFrame(project(), "node-shot1", { ...entry, move: { kind: "spin", meters: 1, seconds: 5 } as never }, frame("f1"), "x")).toThrow("not valid");
  /* A later good save on the same project works. */
  expect(projectSchema.safeParse(withBlockingFrame(project(), "node-shot1", entry, frame("f2"), "Shot 1 · 3D blocking")).success).toBe(true);
});

test("entries for shots that are no longer in the project are dropped as a save is made", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  const entry = { scene, move, savedAt: "2026-10-06T10:20:00.000Z" };
  const p: Project = { ...project(), production: { beats: beats(), blocking: { "node-gone": entry, "node-shot2": entry } } };
  const saved = withBlockingFrame(p, "node-shot1", entry, frame("f1"), "Shot 1 · 3D blocking");
  expect(Object.keys(saved.production!.blocking!).sort()).toEqual(["node-shot1", "node-shot2"]);
});

test("a save and the tidy touch only the input nodes a blocking save made; a person's own reference is never taken off, even of a blocking frame", () => {
  const { scene, move } = sceneFromShot(project(), "node-shot1");
  const entry = { scene, move, savedAt: "2026-10-06T10:20:00.000Z" };
  const shotOf = (p: Project) => p.nodes.find((n) => n.id === "node-shot1")!;
  const assetsOf = (p: Project) => shotOf(p).linked.map((id) => p.nodes.find((n) => n.id === id)!.assetId).sort();
  /* A person's own references: one plain, and one that is a blocking frame they dragged in from the Library (same category, no tag). */
  const mine = frame("mine"); mine.category = "Reference";
  const dragged = frame("dragged");
  let p = project();
  p = { ...p, assets: [mine, dragged] };
  p = { ...p, nodes: [...p.nodes.map((n) => (n.id === "node-shot1" ? { ...n, linked: ["person-1", "person-2"] } : n)),
    { id: "person-1", title: "mine", type: "media", x: 0, y: 0, width: 220, linked: [], assetId: "mine" } as CanvasNode,
    { id: "person-2", title: "dragged", type: "media", x: 0, y: 0, width: 220, linked: [], assetId: "dragged" } as CanvasNode] };
  p = withBlockingFrame(p, "node-shot1", entry, frame("f1"), "Shot 1 · 3D blocking");
  p = withBlockingFrame(p, "node-shot1", entry, frame("f2"), "Shot 1 · 3D blocking");
  expect(assetsOf(p)).toEqual(["dragged", "f2", "mine"]);
  expect(shotOf(p).linked.filter((id) => id.startsWith(BLOCKING_INPUT_PREFIX))).toHaveLength(1);
  /* Two windows' saves merged: a second tagged input is found and tidied; the person's two stay. */
  const merged = withBlockingFrame(p, "node-shot1", entry, frame("f3"), "Shot 1 · 3D blocking");
  const dup = { ...p.nodes.find((n) => n.assetId === "f2")!, id: `${BLOCKING_INPUT_PREFIX}dup` } as CanvasNode;
  const extra: Project = { ...merged, nodes: [...merged.nodes, dup].map((n) => (n.id === "node-shot1" ? { ...n, linked: [...n.linked, dup.id] } : n)) };
  expect(hasStaleBlockingInputs(extra, "node-shot1")).toBe(true);
  const tidy = tidyBlockingInputs(extra, "node-shot1");
  expect(hasStaleBlockingInputs(tidy, "node-shot1")).toBe(false);
  expect(assetsOf(tidy)).toEqual(["dragged", "f3", "mine"]);
  expect(tidyBlockingInputs(tidy, "node-shot1")).toBe(tidy);
  /* An input that has the blocking category but no tag (from before the tag, or dragged in) is left, even when it is not the current frame. */
  const old = frame("old");
  const legacy: Project = { ...tidy, assets: [...tidy.assets, old], nodes: [...tidy.nodes, { id: "node-old", title: "old", type: "media", x: 0, y: 0, width: 220, linked: [], assetId: "old" } as CanvasNode].map((n) => (n.id === "node-shot1" ? { ...n, linked: [...n.linked, "node-old"] } : n)) };
  expect(hasStaleBlockingInputs(legacy, "node-shot1")).toBe(false);
  expect(assetsOf(tidyBlockingInputs(legacy, "node-shot1"))).toContain("old");
  expect(assetsOf(withBlockingFrame(legacy, "node-shot1", entry, frame("f4"), "Shot 1 · 3D blocking"))).toEqual(["dragged", "f4", "mine", "old"]);
});

test("names are trimmed and a blank one never reaches the scene: a beat sheet of spaces still builds a scene that saves", () => {
  const sheet = beats();
  sheet.scenes[0].characters = ["   ", " Runner  "];
  sheet.scenes[0].locations = ["  "];
  sheet.scenes[0].props = ["\t"];
  const p: Project = { ...project(), production: { beats: sheet } };
  const { scene, move } = sceneFromShot(p, "node-shot1");
  expect(scene.objects.map((o) => o.name)).toEqual(["Ground", "Figure 1", "Runner", "Prop 1"]);
  expect(scene.objects.every((o) => o.name === o.name.trim() && o.name.length > 0)).toBe(true);
  const saved = withBlockingFrame(p, "node-shot1", { scene, move, savedAt: "2026-10-06T10:20:00.000Z" }, frame("f1"), "  ");
  expect(projectSchema.safeParse(saved).success).toBe(true);
  expect(addFigure(scene, "   ").objects.at(-1)!.name).toBe("Figure 3");
});
