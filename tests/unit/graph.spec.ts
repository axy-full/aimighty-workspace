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

/* ── The asset layer (surface 2a) ─────────────────────────────────────── */

import {
  layoutAssets, layoutShots, assetWires, assetShapeLine,
  ASSET_W, ASSET_X, SHOT_X, TILE_H, TILE_GAP, ASSET_HEAD, ASSET_HEAD_ORIGIN,
  SHOT_HEAD, SHOT_KEY_H, type AssetIn, type ShotIn,
} from "../../lib/graph";

const port = (id: string, idle = false) => ({ id, label: id.toUpperCase(), version: "v1", idle });
const asset = (id: string, ports: string[], origin: string | null = null): AssetIn =>
  ({ id, name: id, kind: "character", locked: false, origin, ports: ports.map((p) => port(p)) });
const shot = (id: string, slots: string[]): ShotIn => ({
  id, code: id.toUpperCase(), title: id, state: "open", credits: 0,
  slots: slots.map((s) => ({ id: `${id}:${s}`, slot: s.toUpperCase(), label: "x", version: "v1", overridden: false })),
});

test("a port's dot sits at the centre of its own tile", () => {
  const [a] = layoutAssets([asset("cass", ["face", "hair", "wardrobe"])]);
  expect(a.x).toBe(ASSET_X);
  expect(a.ports[0].x).toBe(ASSET_X + ASSET_W);          // the right edge
  expect(a.ports[0].y).toBe(a.y + ASSET_HEAD + 8 + TILE_H / 2);
  // Each following tile is one tile plus its gap further down.
  expect(a.ports[1].y - a.ports[0].y).toBe(TILE_H + TILE_GAP);
  expect(a.ports[2].y - a.ports[1].y).toBe(TILE_H + TILE_GAP);
  // The bundle leaves from the header, meaning every current version at once.
  expect(a.bundleY).toBe(a.y + ASSET_HEAD / 2);
});

test("an element that came from a take carries a taller header, and its ports move with it", () => {
  const [plain] = layoutAssets([asset("a", ["one"])]);
  const [origin] = layoutAssets([asset("b", ["one"], "CREATED FROM A TAKE")]);
  expect(origin.headH).toBe(ASSET_HEAD_ORIGIN);
  expect(origin.ports[0].y - origin.y).toBe(plain.ports[0].y - plain.y + (ASSET_HEAD_ORIGIN - ASSET_HEAD));
});

test("elements stack without overlapping, whatever they hold", () => {
  const placed = layoutAssets([asset("a", ["one"]), asset("b", ["one", "two", "three", "four"]), asset("c", [])]);
  for (let i = 1; i < placed.length; i++) {
    expect(placed[i].y).toBeGreaterThanOrEqual(placed[i - 1].y + placed[i - 1].h);
  }
});

test("a slot's dot sits on the shot's left edge, below the keyframe", () => {
  const [s] = layoutShots([shot("sh04", ["character", "background"])]);
  expect(s.x).toBe(SHOT_X);
  expect(s.slots[0].x).toBe(SHOT_X);
  expect(s.slots[0].y).toBe(s.y + SHOT_HEAD + SHOT_KEY_H + TILE_H / 2);
  expect(s.slots[1].y - s.slots[0].y).toBe(TILE_H);
});

/* The three styles are the three facts a binding holds. A wire cannot say
   something the row does not. */
test("a wire carries the kind it was given, and always leaves left to right", () => {
  const wires = assetWires([
    { key: "a", kind: "inherited", portX: 206, portY: 64, slotX: 280, slotY: 199 },
    { key: "b", kind: "override", portX: 206, portY: 154, slotX: 280, slotY: 573 },
    { key: "c", kind: "created", portX: 206, portY: 485, slotX: 280, slotY: 279 },
  ]);
  expect(wires.map((w) => w.kind)).toEqual(["inherited", "override", "created"]);
  for (const w of wires) {
    expect(w.d.startsWith("M 206 ")).toBe(true);
    expect(w.d).toContain("280");
  }
});

test("the header counts only what is actually pinned", () => {
  expect(assetShapeLine({ locked: 2, overrides: 1, created: 1 })).toBe("2 LOCKED · 1 OVERRIDE · 1 CREATED");
  expect(assetShapeLine({ locked: 0, overrides: 2, created: 0 })).toBe("2 OVERRIDES");
  expect(assetShapeLine({ locked: 0, overrides: 0, created: 0 })).toBe("NOTHING PINNED");
});
