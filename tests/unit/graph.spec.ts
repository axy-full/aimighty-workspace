import { test, expect } from "@playwright/test";
import {
  depths, layout, wiresOf, shapeLine, extent, bandLayout,
  NODE_W, COL, ROW, MAIN_Y, PAD_X, type StageIn,
} from "../../lib/graph";

/* The stage layer (brief 3, surface 1d). The handoff draws one production at
   fixed coordinates; a real recipe is laid out from its own shape. */

const s = (id: string, num: number, inputs: string[] = [], position = num): StageIn =>
  ({ id, num, name: id, inputs, position });

/** The handoff's own recipe: a chain, a branch off the shot list, and a join. */
const NORTHLINE: StageIn[] = [
  s("brief", 1), s("scene", 2, ["brief"]), s("shotlist", 3, ["scene"]),
  s("keyframe", 4, ["shotlist"]), s("motion", 5, ["keyframe"]), s("post", 6, ["motion"]),
  s("audio", 7, ["shotlist"]), s("assembly", 8, ["post", "audio"]),
];

test("a stage sits one column right of the furthest thing feeding it", () => {
  const d = depths(NORTHLINE);
  expect(d.get("brief")).toBe(0);
  expect(d.get("scene")).toBe(1);
  expect(d.get("shotlist")).toBe(2);
  expect(d.get("motion")).toBe(4);
  expect(d.get("post")).toBe(5);
  // Audio branches off the shot list, so it is one past it and not one past Motion.
  expect(d.get("audio")).toBe(3);
  // Assembly waits for BOTH, so it takes the further of the two.
  expect(d.get("assembly")).toBe(6);
});

test("a wire never points backwards", () => {
  const placed = layout(NORTHLINE);
  const at = new Map(placed.map((p) => [p.id, p]));
  for (const p of placed) {
    for (const input of p.inputs) {
      expect(at.get(input)!.x, `${input} → ${p.id}`).toBeLessThan(p.x);
    }
  }
});

test("two stages wanting the same column stack, in the author's order", () => {
  const placed = layout(NORTHLINE);
  const at = new Map(placed.map((p) => [p.id, p]));
  // Nothing shares a column with a chain member here except by branching.
  expect(at.get("brief")!.y).toBe(MAIN_Y);
  expect(at.get("brief")!.x).toBe(PAD_X);
  expect(at.get("scene")!.x).toBe(PAD_X + COL);

  // Force a collision: a second stage off the shot list.
  const withTwo = [...NORTHLINE, s("stills", 9, ["shotlist"], 9)];
  const two = layout(withTwo);
  const audio = two.find((p) => p.id === "audio")!;
  const stills = two.find((p) => p.id === "stills")!;
  expect(audio.col).toBe(stills.col);
  expect(stills.y).toBe(audio.y + ROW);       // the later one drops a row
  expect(stills.position).toBeGreaterThan(audio.position);
});

test("a recipe that feeds itself lays out instead of hanging", () => {
  const loop: StageIn[] = [s("a", 1, ["b"]), s("b", 2, ["a"]), s("c", 3, ["b"])];
  const d = depths(loop);
  expect(d.size).toBe(3);
  for (const v of d.values()) expect(Number.isFinite(v)).toBe(true);
  expect(layout(loop)).toHaveLength(3);
});

test("wires are drawn only between stages that both exist", () => {
  const placed = layout(NORTHLINE);
  const wires = wiresOf(placed);
  expect(wires).toHaveLength(8);   // one per input edge across the recipe
  expect(wires.every((w) => w.d.startsWith("M "))).toBe(true);

  // An input naming something that is not in the recipe draws nothing.
  const dangling = layout([s("a", 1), s("b", 2, ["a", "ghost"])]);
  expect(wiresOf(dangling)).toHaveLength(1);
});

test("the graph is big enough to hold what was put on it", () => {
  const placed = layout(NORTHLINE);
  const band = bandLayout(3);
  const { w, h } = extent(placed, band);
  for (const p of placed) {
    expect(p.x + NODE_W).toBeLessThanOrEqual(w);
    expect(p.y).toBeLessThan(h);
  }
  expect(extent([], []).w).toBe(860);   // the handoff's own size, for an empty recipe
});

test("the toolbar counts what is actually there", () => {
  const placed = layout(NORTHLINE);
  expect(shapeLine(placed, 3)).toBe("8 STAGES · 3 LOCKED · 1 BRANCH");
  expect(shapeLine(layout([s("a", 1)]), 0)).toBe("1 STAGE · 0 BRANCHES");
});
