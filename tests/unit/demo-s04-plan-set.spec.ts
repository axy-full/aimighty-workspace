import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import type { BoardSource } from "../../lib/board/types";
import { railStatus, STUDIO_GROUP, STUDIO_RAIL } from "../../lib/board/regions";
import { derivePlanCards } from "../../components/graphite/board/cards/plan/derive";

/* Board cards 1 on the board (stream 3's CardSet.derive): the brief, briefs on the canvas, and the Storyboard group. */

const NOW = "2026-10-05T10:00:00.000Z";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const beats: BeatSheet = {
  scriptSha256: SHA, updatedAt: NOW,
  scenes: [{
    id: "scene-a", heading: "", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-1", description: "Fog lifts.", framing: "Extreme wide", movement: "Locked off", lighting: "", sound: "", duration: 4 },
      { id: "shot-2", description: "A runner.", framing: "Medium", movement: "Slow push", lighting: "", sound: "", duration: 6 },
    ],
  }],
};
const node = (id: string, type: CanvasNode["type"], title: string, text = ""): CanvasNode => ({ id, title, type, x: 0, y: 0, width: 254, linked: [], text });

function src(project: Project, agent: BoardSource["agent"] = null): BoardSource {
  return { kind: "studio", project, shots: [], jobs: [], library: [], masters: new Set(), agent, now: 0 };
}
const base = (over: Partial<Project> = {}): Project => ({ ...newProject("Test film"), aspect: "16:9", fps: 24, brief: "A runner at dawn.", direction: "Cold light.", production: { beats }, ...over });

test("the brief, the Storyboard group and a frame per shot, in production order", () => {
  const cards = derivePlanCards(src(base()));
  expect(cards.map((c) => [c.id, c.kind, c.region, c.group ?? null, c.order])).toEqual([
    ["doc:brief", "doc", "brief", null, 0],
    [STUDIO_GROUP.storyboard, "group", "storyboard", null, -1],
    ["frame:shot-1", "frame", "storyboard", STUDIO_GROUP.storyboard, 1],
    ["frame:shot-2", "frame", "storyboard", STUDIO_GROUP.storyboard, 2],
  ]);
  expect(cards[1].data).toEqual({ title: "Storyboard", meta: "2 shots · no frames yet", columns: 2 });
  /* Plain data only: a card's data never carries a function. */
  expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
});

test("the rail reads the brief done and the storyboard waiting on the approval", () => {
  const drawn = base({ production: { beats, boards: { style: "live", model: "gemini-3.1-flash-image", frames: {
    "shot-1": { prompt: "p", takes: [{ genId: "g1", style: "live", at: NOW }] }, "shot-2": { prompt: "p", takes: [{ genId: "g2", style: "live", at: NOW }] },
  } } } });
  const rail = railStatus(STUDIO_RAIL, derivePlanCards(src(drawn)));
  expect(rail.get("brief")).toMatchObject({ state: "done", summary: "Brief · 1 document" });
  expect(rail.get("storyboard")).toMatchObject({ state: "needs", count: 1, summary: "2 frames · approve to make shots" });
  /* Once Atomik's run is past its approval, the storyboard is done. */
  const running = { state: "running", paid: [] } as unknown as NonNullable<BoardSource["agent"]>;
  expect(railStatus(STUDIO_RAIL, derivePlanCards(src(drawn, running))).get("storyboard")).toMatchObject({ state: "done" });
});

test("an empty brief puts no card down (the empty board is the way in); a canvas brief is drawn as a doc", () => {
  const empty = base({ brief: "", direction: "", production: undefined });
  expect(derivePlanCards(src(empty))).toEqual([]);
  const withNode = base({ brief: "", direction: "", production: undefined, nodes: [node("node-brief01", "brief", "Notes", "Keep it quiet."), node("node-shot01", "scene", "Shot")] });
  const cards = derivePlanCards(src(withNode));
  expect(cards.map((c) => [c.id, c.kind, c.nodeId])).toEqual([["node-brief01", "doc", "node-brief01"]]);
  expect(cards[0].data).toEqual({ variant: "node", nodeId: "node-brief01", title: "Notes", text: "Keep it quiet." });
});

test("once the Shots cards take over (a render on its way), the storyboard group gives way", () => {
  const rendering = { state: "running", paid: [{ seq: 1, tool: "render", state: "rendering" }] } as unknown as NonNullable<BoardSource["agent"]>;
  const waiting = { state: "needs_you", paid: [{ seq: 1, tool: "render", state: "waiting" }] } as unknown as NonNullable<BoardSource["agent"]>;
  expect(derivePlanCards(src(base(), waiting)).some((c) => c.id === STUDIO_GROUP.storyboard)).toBe(true);
  const cards = derivePlanCards(src(base(), rendering));
  expect(cards.map((c) => c.id)).toEqual(["doc:brief"]);
});
