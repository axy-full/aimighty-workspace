import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import type { BoardSource } from "../../lib/board/types";
import { railStatus, STUDIO_GROUP, STUDIO_RAIL } from "../../lib/board/regions";
import { derivePlanCards, PLAN_CARD_ID } from "../../components/graphite/board/cards/plan/derive";
import { planCardHeight } from "../../components/graphite/board/cards/plan/model";
import { nextChoices, nextPreset, showWhereNext } from "../../components/graphite/board/cards/plan/next";

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
  /* The plan stands alone beside the Shots cards while the run is working. */
  expect(cards.map((c) => c.id)).toEqual(["doc:brief", "plan:run"]);
  expect(cards[1]).toMatchObject({ region: "shots", state: "working" });
});

const step = (seq: number, state: string) => ({ seq, tool: "render", title: `Shot ${seq}`, state });
const runOf = (state: string, paid = [step(1, "next"), step(2, "next"), step(3, "next")]) =>
  ({ id: "rar_000000000000000000000001", state, reason: null, paid }) as unknown as NonNullable<BoardSource["agent"]>;

test("a proposal puts the plan in the Storyboard group's open slot, needing you; folding its steps changes its box", () => {
  const cards = derivePlanCards(src(base(), runOf("awaiting_approval")));
  const plan = cards.find((c) => c.id === PLAN_CARD_ID)!;
  expect(plan).toMatchObject({ kind: "plan", region: "storyboard", group: STUDIO_GROUP.storyboard, state: "needs" });
  expect(plan.order).toBeGreaterThan(cards.filter((c) => c.kind === "frame").length);
  expect((plan.data as { open: boolean }).open).toBe(false);
  const run = runOf("awaiting_approval");
  expect(planCardHeight(run, true)).toBeGreaterThan(planCardHeight(run, false));
  /* Past the proposal its steps are always shown, so the box already holds them. */
  expect(planCardHeight(runOf("running"), false)).toBeGreaterThan(planCardHeight(run, false));
  expect(planCardHeight(run, false) % 4).toBe(0);
});

test("a finished, stopped or planning run puts no plan on the board; neither does a run with no render", () => {
  for (const state of ["planning", "done", "stopped", "failed"]) expect(derivePlanCards(src(base(), runOf(state))).some((c) => c.kind === "plan")).toBe(false);
  expect(derivePlanCards(src(base(), runOf("awaiting_approval", []))).some((c) => c.kind === "plan")).toBe(false);
  expect(derivePlanCards(src(base(), null)).some((c) => c.kind === "plan")).toBe(false);
});

test("a picked look names the storyboard; its group of looks is the fallback group's id, with a tile per look", () => {
  const withLooks = base({ production: { beats, boards: { style: "live", model: "gemini-3.1-flash-image", frames: {}, look: "golden-hour", looks: {
    "golden-hour": { name: "Golden hour", prompt: "p", takes: [{ genId: "g-a", at: NOW }], selected: "g-a" },
    "blue-hour": { name: "Blue hour", prompt: "p", takes: [{ genId: "g-b", at: NOW }], selected: "g-b" },
  } } } });
  const cards = derivePlanCards(src(withLooks));
  const group = cards.find((c) => c.id === STUDIO_GROUP.looks)!;
  expect(group).toMatchObject({ kind: "group", region: "looks", state: "done", summary: "Golden hour picked" });
  expect((group.data as { meta: string }).meta).toBe("Golden hour picked");
  expect(cards.filter((c) => c.kind === "look").map((c) => [c.id, c.group, c.state])).toEqual([
    ["look:golden-hour", STUDIO_GROUP.looks, "done"], ["look:blue-hour", STUDIO_GROUP.looks, "done"],
  ]);
  expect(cards.find((c) => c.id === "look:golden-hour")!.data).toMatchObject({ picked: true, meta: "Nano Banana Pro · 1K" });
  /* No looks made: no group of looks (stream 3's fallback stands for Rig look boards). */
  expect(derivePlanCards(src(base())).some((c) => c.region === "looks")).toBe(false);
});

test("Where to next? comes once every shot has an approved take, as three cards in their own group", () => {
  const takes = (state: "approved" | "review") => [{ shown: { status: state }, versions: [] }] as never;
  expect(showWhereNext([])).toBe(false);
  expect(showWhereNext(takes("review"))).toBe(false);
  expect(showWhereNext([...takes("approved"), ...takes("review")])).toBe(false);
  expect(showWhereNext(takes("approved"))).toBe(true);
  expect(nextChoices("16:9").map((c) => [c.id, c.name])).toEqual([["vertical", "9:16 cutdown"], ["stills", "Campaign stills"], ["crew", "Crew review of the cut"]]);
  expect(nextChoices("9:16")[0].name).toBe("16:9 version");
  expect(nextPreset("vertical", "16:9")).toMatchObject({ type: "video", picks: { ratio: "9:16" } });
  expect(nextPreset("stills", "16:9")).toMatchObject({ type: "image", picks: { resolution: "1K" } });
  /* Nothing on these cards makes a price up: no figure is written into any line. */
  expect(nextChoices("16:9").some((c) => /\d\s*cr\b|free/i.test(c.line))).toBe(false);
});
