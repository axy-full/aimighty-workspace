import { test, expect } from "@playwright/test";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import { productionSchema } from "../../lib/workbench/studio-schema";
import { DEFAULT_BOARDS } from "../../lib/production/boards";
import { LOOK_MODEL, LOOK_PRESETS, lookPrompt, lookRequest } from "../../lib/production/looks";
import { looks, pendingLooks, pickedLook, withLandedLook, withPendingLook, withPickedLook } from "../../components/graphite/board/cards/looks/model";

/* Looks before the storyboard (design/particl-graphite/README.md § 3.1 c; lead decision 28). */

const NOW = "2026-10-05T10:00:00.000Z";
const project = (over: Partial<Project> = {}): Project => ({
  ...newProject("Test film"), aspect: "16:9", productionProjectId: "prod-1", brief: "A runner meets the dawn.", direction: "Cold light.", ...over,
});
const [golden, blue] = LOOK_PRESETS;

test("four film-term looks, made on Nano Banana Pro at 1K in the project's ratio", () => {
  expect(LOOK_PRESETS.map((p) => p.name)).toEqual(["Golden hour", "Blue hour", "Bleach bypass", "Clean daylight"]);
  const prompt = lookPrompt(project(), golden, "Two variations of the direction.");
  expect(prompt).toContain("A still frame from this film: A runner meets the dawn.");
  expect(prompt).toContain("Look: Golden hour");
  expect(prompt).toContain("Two variations of the direction.");
  const body = lookRequest(project(), { prompt })!;
  expect([body.kind, body.model.id, body.ratio, body.resolution, body.references]).toEqual(["image", LOOK_MODEL, "16:9", "1K", []]);
  const face: Asset = { id: "gen-face", generationId: "gen-face", kind: "image", category: "Cast", name: "Lead", url: "/api/media/gen-face", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
  expect(lookRequest(project(), { prompt }, face)!.references).toEqual([{ genId: "gen-face", role: "reference_image" }]);
  expect(lookRequest(project({ productionProjectId: undefined }), { prompt })).toBeNull();
});

test("no looks: an empty region and all four to make; sent, they draw; landed, one is picked", () => {
  let p = project();
  expect(looks(p)).toMatchObject({ state: "empty", summary: "Nothing yet", tiles: [], picked: null });
  expect(looks(p).toMake).toHaveLength(4);
  p = withPendingLook(p, golden, "prompt a", { jobId: "job-a", at: NOW });
  p = withPendingLook(p, blue, "prompt b", { jobId: "job-b", at: NOW });
  expect(pendingLooks(p)).toEqual([{ id: "golden-hour", jobId: "job-a" }, { id: "blue-hour", jobId: "job-b" }]);
  expect(looks(p)).toMatchObject({ state: "working", summary: "Drawing 2 looks" });
  expect(looks(p).toMake.map((l) => l.id)).toEqual(["bleach-bypass", "clean-daylight"]);
  p = withLandedLook(p, "golden-hour", "job-a", "gen-a", NOW);
  p = withLandedLook(p, "blue-hour", "job-b", null, NOW);
  const now = looks(p);
  expect(now.tiles.map((t) => [t.name, t.genId, t.meta])).toEqual([["Golden hour", "gen-a", "Nano Banana Pro · 1K"], ["Blue hour", null, "Nano Banana Pro · 1K"]]);
  expect(now).toMatchObject({ state: "needs", summary: "1 look · pick one", meta: "pick one, or tell Atomik what to change" });
  /* The one that did not render is made again. */
  expect(now.toMake.map((l) => l.id)).toEqual(["blue-hour", "bleach-bypass", "clean-daylight"]);
  expect(p.assets.filter((a) => a.category === "Look").map((a) => a.name)).toEqual(["Look · Golden hour"]);
  p = withPickedLook(p, "golden-hour");
  expect(looks(p)).toMatchObject({ state: "done", summary: "Golden hour picked", meta: "Golden hour picked", picked: "Golden hour" });
  expect(pickedLook(p)?.asset?.id).toBe("gen-a");
  expect(withPickedLook(p, "golden-hour")).toBe(p);
  expect(withPickedLook(p, "nonsense")).toBe(p);
});

test("the draft schema takes the looks and the pick, and drafts from before them still parse", () => {
  const before = { boards: { ...DEFAULT_BOARDS } };
  expect(productionSchema.safeParse(before).success).toBe(true);
  const p = withPickedLook(withLandedLook(withPendingLook(project(), golden, "prompt", { jobId: "job-a", at: NOW }), "golden-hour", "job-a", "gen-a", NOW), "golden-hour");
  expect(productionSchema.safeParse(p.production).success).toBe(true);
  const stray = { boards: { ...DEFAULT_BOARDS, looks: { "golden-hour": { name: "x", prompt: "y", takes: [], extra: 1 } } } };
  expect(productionSchema.safeParse(stray).success).toBe(false);
  expect(productionSchema.safeParse({ boards: { ...DEFAULT_BOARDS, look: "Not An Id" } }).success).toBe(false);
});
