import { test, expect } from "@playwright/test";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { kindSectionId } from "../../lib/workspace/rig-board";
import type { RigShot } from "../../lib/workspace/shots";
import { BAND_LEFT, BOARD_DOTS, layoutBoard, type LayoutItem } from "../../lib/board/layout";
import { nodeRole, nodesForSet, regionStatus, railStatus, STUDIO_BANDS, STUDIO_RAIL } from "../../lib/board/regions";
import { addFreeCard, dropPlace, moveFreeCards, removeFreeCards, restoreFreeCards } from "../../lib/board/snap";
import { shotRows } from "../../lib/board/list";
import { boardKindOf } from "../../lib/board/kind";
import { frameDrawer, frameRegion } from "../../lib/board/frames";
import { cubicBezier } from "../../lib/board/ease";
import type { BoardCard } from "../../lib/board/types";

/* Stream 3 · the board canvas's pure parts (lib/board). Neutral names only. */

const node = (id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title: id, type, x: 0, y: 0, width: 254, linked: [], ...extra });
const project = (nodes: CanvasNode[], extra: Partial<Project> = {}): Project => ({ ...newProject("Fixture"), nodes, ...extra });
const card = (id: string, extra: Partial<BoardCard> = {}): BoardCard => ({ id, kind: "x", region: null, order: 0, state: "empty", data: {}, ...extra });

test.describe("layout", () => {
  const item = (id: string, region: LayoutItem["region"], order: number, w = 300, h = 200, extra: Partial<LayoutItem> = {}): LayoutItem =>
    ({ id, region, order, size: { w, h }, ...extra });

  test("bands stack top to bottom in production order, regions of one band side by side, left of x = 0", () => {
    const out = layoutBoard([item("shot", "shots", 0), item("brief", "brief", 0, 220), item("frame", "storyboard", 0), item("look", "looks", 0)], STUDIO_BANDS);
    const [look, brief, frame, shot] = ["look", "brief", "frame", "shot"].map((id) => out.boxes.get(id)!);
    expect(look.y).toBeLessThan(brief.y);
    expect(brief.y).toBe(frame.y);
    expect(brief.x).toBe(BAND_LEFT);
    expect(frame.x).toBeGreaterThan(brief.x + brief.w);
    expect(shot.y).toBeGreaterThan(frame.y + frame.h);
    for (const box of out.boxes.values()) expect(box.x + box.w).toBeLessThanOrEqual(0);
  });

  test("a group is sized by its cards, which sit inside it in columns", () => {
    const out = layoutBoard([
      item("group", "shots", 0, 100, 100, { container: { columns: 2, gap: 10, pad: { top: 20, right: 20, bottom: 20, left: 20 } } }),
      item("a", "shots", 0, 340, 200, { group: "group" }), item("b", "shots", 1, 340, 200, { group: "group" }), item("c", "shots", 2, 340, 200, { group: "group" }),
    ], STUDIO_BANDS);
    const g = out.boxes.get("group")!, a = out.boxes.get("a")!, b = out.boxes.get("b")!, c = out.boxes.get("c")!;
    expect(g.w).toBe(20 + 340 + 10 + 340 + 20);
    expect(g.h).toBe(20 + 200 + 10 + 200 + 20);
    expect([a.x - g.x, a.y - g.y]).toEqual([20, 20]);
    expect(b.x).toBe(a.x + 350);
    expect(c.y).toBe(a.y + 210);
  });

  test("a free card stays where it was saved; an empty region gets a slot to glide to; the same cards give the same places", () => {
    const items = [item("note", null, 0, 254, 168, { at: { x: 96, y: 72 } }), item("shot", "shots", 0)];
    const out = layoutBoard(items, STUDIO_BANDS);
    expect(out.boxes.get("note")).toEqual({ x: 96, y: 72, w: 254, h: 168 });
    expect(out.slots.has("cast")).toBe(true);
    expect(out.regions.has("cast")).toBe(false);
    expect(out.arranged).toEqual(out.boxes.get("shot"));
    expect(layoutBoard(items, STUDIO_BANDS)).toEqual(out);
  });
});

test.describe("regions", () => {
  test("every one of today's node types has one place on the board", () => {
    const shot = node("shot", "scene", { linked: ["ref"] });
    const nodes = [
      shot, node("gen", "generate"), node("look", "moodboard"), node("brief", "brief"), node("note", "note"),
      node("cast", "character"), node("place", "element", { refKind: "environment" }), node("ref", "media", { refKind: "ref" }),
      node("upload", "media", { refKind: "ref" }), node("grade", "grade"), node("out", "output"),
      node("made", "note", { mode: "section" }), node(kindSectionId("cast"), "note", { mode: "section" }), { ...node("newer", "note"), type: "storyboard-v9" as CanvasNode["type"] },
    ];
    const role = (id: string) => nodeRole(nodes.find((n) => n.id === id)!, nodes, { assets: [] });
    expect(role("shot")).toEqual({ kind: "take", region: "shots", set: "shots" });
    expect(role("gen").kind).toBe("take");
    expect(role("look")).toEqual({ kind: "looks", region: "looks", set: "plan" });
    expect(role("brief")).toEqual({ kind: "doc", region: "brief", set: "plan" });
    expect(role("cast")).toEqual({ kind: "cast", region: "cast", set: "shots" });
    expect(role("place").kind).toBe("cast");
    expect(role("ref").kind).toBeNull();
    expect(role("upload")).toEqual({ kind: "media", region: null, set: "board" });
    expect(role("note")).toEqual({ kind: "note", region: null, set: "board" });
    expect(role("grade")).toEqual({ kind: "tool", region: "cut", set: "board" });
    expect(role("out").region).toBe("deliver");
    expect(role("made").kind).toBe("label");
    expect(role(kindSectionId("cast")).kind).toBeNull();
    expect(role("newer")).toEqual({ kind: "unknown", region: null, set: "board" });
  });

  test("no node is drawn by two sets", () => {
    const p = project([node("a", "scene"), node("b", "moodboard"), node("c", "note"), node("d", "character"), node("e", "grade")]);
    const ids = (["board", "plan", "shots"] as const).flatMap((set) => nodesForSet(p, set).map((x) => x.node.id));
    expect(ids.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("a region rolls its cards up: needs (counted) over working over done over empty", () => {
    expect(regionStatus([])).toEqual({ state: "empty", count: 0, summary: "Nothing yet", cards: 0 });
    expect(regionStatus([card("a", { state: "done", summary: "Done" }), card("b", { state: "working", summary: "Rendering 1 of 3" })]).summary).toBe("Rendering 1 of 3");
    const needs = regionStatus([card("a", { state: "needs", needs: 2 }), card("b", { state: "needs" }), card("c", { state: "working" })]);
    expect([needs.state, needs.count]).toEqual(["needs", 3]);
    const rail = railStatus(STUDIO_RAIL, [card("a", { region: "cast", state: "done" })]);
    expect(rail.get("cast")!.state).toBe("done");
    expect(rail.get("brief")!.state).toBe("empty");
  });
});

test.describe("free cards", () => {
  test("a card let go lands on the 24 px dots; with Alt, where it was let go; never off the canvas", () => {
    expect(dropPlace({ x: 37, y: 13 })).toEqual({ x: 48, y: 24 });
    expect(dropPlace({ x: 35, y: 11 })).toEqual({ x: 24, y: 0 });
    expect(dropPlace({ x: -11, y: 11 })).toEqual({ x: 0, y: 0 });
    expect(dropPlace({ x: 35.4, y: 13.6 }, true)).toEqual({ x: 35, y: 14 });
    expect(dropPlace({ x: 99_999, y: -99_999 })).toEqual({ x: 20_000, y: -10_000 });
    expect(BOARD_DOTS).toBe(24);
  });

  test("move, add, take off and put back are draft edits; a locked card refuses; a card in use stays", () => {
    const p = project([node("n1", "note", { x: 0, y: 0 }), node("lock", "note", { locked: true }), node("feeds", "media"), node("shot", "scene", { linked: ["feeds"] })]);
    expect(moveFreeCards(p, [{ id: "n1", x: 48, y: 96 }]).nodes[0]).toMatchObject({ x: 48, y: 96 });
    expect(moveFreeCards(p, [{ id: "n1", x: 0, y: 0 }])).toBe(p);
    expect(() => moveFreeCards(p, [{ id: "lock", x: 24, y: 24 }])).toThrow(/Unlock/);
    const added = addFreeCard(p, "label", { x: 50, y: 50 }, "label-1");
    expect(added.nodes.at(-1)).toMatchObject({ id: "label-1", type: "note", mode: "section", x: 48, y: 48, title: "Text" });
    expect(addFreeCard(added, "label", { x: 0, y: 0 }, "label-1")).toBe(added);
    const out = removeFreeCards(added, ["label-1", "feeds", "lock"]);
    expect(out.removed.map((n) => n.id)).toEqual(["label-1"]);
    expect(restoreFreeCards(out.project, out.removed).nodes.map((n) => n.id)).toEqual(added.nodes.map((n) => n.id));
  });
});

test.describe("list, kind, frames, easing, the draft key", () => {
  test("the shot list follows the beat sheet, joined to its board shots, with running times", () => {
    const beats = { scriptSha256: "x", updatedAt: "now", scenes: [{ id: "s1", heading: "Market", summary: "", beats: [], characters: [], locations: [], props: [], shots: [
      { id: "b1", description: "Wide on the stalls", framing: "Wide", movement: "Locked off", lighting: "", sound: "", duration: 4 },
      { id: "b2", description: "Hands on a shutter", framing: "Close", movement: "Slow push", lighting: "", sound: "", duration: 6 },
    ] }] };
    const p = project([node("shot-b1", "scene", { boardShotId: "b1" })], { production: { beats } });
    const shots = [{ id: "shot-b1", index: 1, status: "approved", durationS: 4, note: "", name: "Wide" } as unknown as RigShot];
    const rows = shotRows(p, shots);
    expect(rows.map((r) => [r.number, r.start, r.action, r.size, r.camera, r.state, r.cardId])).toEqual([
      ["1.1", "0:00", "Wide on the stalls", "Wide", "Locked off", "Approved", "shot-b1"],
      ["1.2", "0:04", "Hands on a shutter", "Close", "Slow push", "Draft", null],
    ]);
  });

  test("a project's board kind: its own key, else read from its data", () => {
    expect(boardKindOf(null)).toBe("studio");
    expect(boardKindOf({ boardKind: "social" })).toBe("social");
    expect(boardKindOf({ marketingBrief: {} as Project["marketingBrief"] })).toBe("ads");
    expect(boardKindOf({})).toBe("studio");
  });

  test("the draft takes an optional boardKind; drafts without it still parse", () => {
    const base = newProject("Fixture");
    expect(projectSchema.safeParse(base).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, boardKind: "ads" }).success).toBe(true);
    expect(projectSchema.safeParse({ ...base, boardKind: "poster" }).success).toBe(false);
  });

  test("design frame letters land on regions and drawers", () => {
    expect([frameRegion("a"), frameRegion("d"), frameRegion("f2"), frameRegion("h"), frameRegion("i"), frameRegion("j"), frameRegion("z"), frameRegion(null)])
      .toEqual(["brief", "storyboard", "shots", "cast", "cut", "deliver", null, null]);
    expect([frameDrawer("o"), frameDrawer("p"), frameDrawer("d")]).toEqual(["library", "history", null]);
  });

  test("the glide's easing is the design's cubic-bezier(.2,.7,.2,1)", () => {
    const ease = cubicBezier(0.2, 0.7, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.8);
  });
});
