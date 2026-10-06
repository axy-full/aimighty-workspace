import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import {
  LENSES, addFigure, addProp, blockingOf, blockingSchema, cameraView, moveAt, moveEnd, moveWords, roleOf, sceneFromShot, shotSource, withBlockingFrame, withCameraView, withLens,
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
const frame = (id: string): Asset => ({ id, uploadId: `up-${id}`, name: "Shot 1 · 3D blocking", kind: "image", category: "3D blocking", url: `/api/uploads/up-${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });

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

test("production.blocking is additive and optional: a project from before parses as it did, and one with blocking parses and keeps it", () => {
  const plain = project();
  const { scene, move } = sceneFromShot(plain, "node-shot1");
  const before = projectSchema.safeParse(plain);
  expect(before.success, JSON.stringify(before.error?.issues[0])).toBe(true);
  expect(projectSchema.safeParse({ ...plain, production: { ...plain.production, blocking: undefined } }).success).toBe(true);
  const withIt = { ...plain, production: { ...plain.production, blocking: { "node-shot1": { scene, move, savedAt: "2026-10-06T10:20:00.000Z", frameAssetId: "f1" } } } };
  const parsed = projectSchema.safeParse(withIt);
  expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
  expect(parsed.success && parsed.data.production?.blocking?.["node-shot1"]?.move).toEqual(move);
  /* Everything else in the project is exactly what it was. */
  if (parsed.success && before.success) expect({ ...parsed.data, production: { ...parsed.data.production, blocking: undefined } }).toEqual({ ...before.data, production: { ...before.data.production, blocking: undefined } });
  /* A bad entry is refused, not kept. */
  expect(blockingSchema.safeParse({ "node-shot1": { scene, move: { kind: "spin", meters: 1, seconds: 5 }, savedAt: "2026-10-06T10:20:00.000Z" } }).success).toBe(false);
  expect(blockingSchema.safeParse({ "../x": { scene, move, savedAt: "2026-10-06T10:20:00.000Z" } }).success).toBe(false);
  expect(blockingSchema.safeParse({ "node-shot1": { scene, move, savedAt: "2026-10-06T10:20:00.000Z", extra: 1 } }).success).toBe(false);
});

/*
 * The branch-copy check the lead runs before Thursday's train (read-only unless BLOCKING_BRANCH_WRITE=1). It needs a copy of the
 * production database, never the database itself:
 *   BLOCKING_BRANCH_DB_URL=<the branch copy's libsql:// url> BLOCKING_BRANCH_DB_TOKEN=<its token> \
 *   BLOCKING_BRANCH_WRITE=1 npx playwright test --project=unit tests/unit/demo-gaps-l2-blocking.spec.ts -g "branch copy"
 * 1. Every stored project body on the copy still parses exactly as it did (nothing existing changes: the field is optional).
 * 2. With BLOCKING_BRANCH_WRITE=1, one throwaway row (owner "branch-check") carrying production.blocking is written, read back,
 *    parsed with the same schema, and deleted; no other row is written or deleted. No table or column changes: the field lives inside
 *    the project's JSON body.
 */
test("branch copy: stored projects parse as they did, and a project with blocking round-trips through the database", async () => {
  const url = process.env.BLOCKING_BRANCH_DB_URL;
  test.skip(!url, "set BLOCKING_BRANCH_DB_URL (a branch copy) to run this");
  const db = createClient({ url: url!, authToken: process.env.BLOCKING_BRANCH_DB_TOKEN });
  try {
    const rows = (await db.execute("SELECT project_id, body FROM workbench_projects")).rows;
    let failed = 0, withField = 0;
    for (const row of rows) {
      let body: unknown;
      try { body = JSON.parse(String(row.body)); } catch { failed++; continue; }
      if ((body as { production?: { blocking?: unknown } })?.production?.blocking !== undefined) withField++;
      if (!projectSchema.safeParse(body).success) failed++;
    }
    console.log(`branch copy: ${rows.length} stored projects, ${failed} that do not parse, ${withField} that already carry production.blocking`);
    /* The count of projects that do not parse is reported for the lead; the new field adds none (it is absent from every row). */
    expect(withField).toBe(0);
    if (process.env.BLOCKING_BRANCH_WRITE === "1") {
      const plain = project();
      const { scene, move } = sceneFromShot(plain, "node-shot1");
      const body = { ...plain, production: { ...plain.production, blocking: { "node-shot1": { scene, move, savedAt: new Date().toISOString() } } } };
      const key = `branch-check:${randomUUID()}`;
      await db.execute({ sql: "INSERT INTO workbench_projects (key,owner,project_id,name,body,revision,updated_at) VALUES (?,?,?,?,?,1,?)", args: [key, "branch-check", plain.id, "branch check", JSON.stringify(body), Date.now()] });
      try {
        const back = (await db.execute({ sql: "SELECT body FROM workbench_projects WHERE key = ?", args: [key] })).rows[0];
        const parsed = projectSchema.safeParse(JSON.parse(String(back.body)));
        expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
        expect(parsed.success && Object.keys(parsed.data.production?.blocking ?? {})).toEqual(["node-shot1"]);
      } finally { await db.execute({ sql: "DELETE FROM workbench_projects WHERE key = ? AND owner = 'branch-check'", args: [key] }); }
    }
  } finally { db.close(); }
});
