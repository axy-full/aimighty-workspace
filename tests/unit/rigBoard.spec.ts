import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../../lib/workbench/studio";
import { canvasNodeSchema, saveSchema } from "../../lib/workbench/studio-schema";
import { canConnect } from "../../lib/workbench/node-graph";
import { cardLabel } from "../../lib/workbench/ref-kind";
import { applyTeamPatch, diffForTeam, emptyTeamCanvas, parseTeamCanvas, withTeamCanvas, type TeamCanvas } from "../../lib/workbench/team-canvas-model";
import { planCanvasOps, type CanvasOp } from "../../lib/workbench/canvas-ops-model";
import { undoOps } from "../../lib/workbench/rig-agent-plan";
import { mergeDraft } from "../../lib/workbench/draft-merge";
import { flowChain } from "../../lib/workspace/mobile-templates";
import { cardHeight, cardWidth, CARD_HEIGHT, graphLayout, isSectionNode } from "../../lib/workspace/rig-graph";
import {
  addBoardCard, BOARD_GRID, BOARD_GROUP_TITLES, boardGroupOf, boardSections, cardStatus, clampPosition, dragShown, dropCard, dropPlace,
  filingAt, freeSpot, kindSectionId, sectionAt, sectionedFlow, sectionGroup, snapTo, TIDY, tidyBoard, withBoardText,
} from "../../lib/workspace/rig-board";

/*
 * The Rig board, laid out so a big board reads at a glance (plan PR 3): section
 * titles that group cards, notes edited on the board, a 20 px snap, cards that
 * say their kind, state and version, and a Tidy that lays the board out by
 * sections on the server for everyone. All pure here, plus the one new node
 * field through the schema, the team canvas and the merge.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rig-board-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const card = (id: string, type: NodeType, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type, x: 0, y: 0, width: type === "scene" || type === "generate" ? 238 : 220, linked: [], ...extra });
const title = (id: string, name: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: name, type: "note", mode: "section", x: 0, y: 0, width: 260, linked: [], ...extra });
const asset = (id: string, category = "Reference"): Asset => ({ id, name: id, kind: "image", category, url: `/api/uploads/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const assets = { assets: [asset("plate", "Environment"), asset("face", "Character"), asset("frame")] };
const project = (nodes: CanvasNode[], extra: Partial<Project> = {}): Project => ({ ...newProject("Board"), id: "draft-board", productionProjectId: "prod-board", nodes, assets: assets.assets, ...extra });
const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);
const CAST = kindSectionId("cast"), SHOTS = kindSectionId("shots"), REFS = kindSectionId("ref");

/** Every card of a laid-out board, as the boxes the graph draws. */
const boxes = (nodes: readonly CanvasNode[]) => nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: cardWidth(n), h: cardHeight(n) }));
const overlapping = (nodes: readonly CanvasNode[]) => {
  const all = boxes(nodes), out: string[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id}×${b.id}`);
  }
  return out;
};
/** A board as a Tidy leaves it: its cards in their spots, and the titles it made, after them in canvas order. */
function tidied(nodes: CanvasNode[], options: Parameters<typeof tidyBoard>[2] = {}) {
  const plan = tidyBoard(nodes, assets, options);
  const at = new Map(plan.spots.map((s) => [s.id, s]));
  const placed = nodes.map((n) => { const s = at.get(n.id); return s ? { ...n, x: s.x, y: s.y, ...(s.width === undefined ? {} : { width: s.width }) } : n; });
  return { plan, nodes: [...placed, ...plan.made] };
}

/* ── Snap ─────────────────────────────────────────────────────────────── */

test("snap: a card let go lands on the 20 px grid, Alt places it exactly, and it never leaves the canvas's bounds", () => {
  expect([0, 9, 10, 29, 30, -9, -10, -11, 150, 20_010].map((v) => snapTo(v))).toEqual([0, 0, 20, 20, 40, 0, 0, -20, 160, 20_020]);
  expect(Object.is(snapTo(-10), -0)).toBe(false);
  expect(BOARD_GRID).toBe(20);
  /* 59 × 39 board units from (100, 100): the grid's (160, 140); with Alt, exactly (159, 139). */
  expect(dropPlace({ x: 100, y: 100 }, { dx: 59, dy: 39 })).toEqual({ x: 160, y: 140 });
  expect(dropPlace({ x: 100, y: 100 }, { dx: 59, dy: 39 }, true)).toEqual({ x: 159, y: 139 });
  /* A card that was not on the grid lands on it wherever it goes. */
  expect(dropPlace({ x: 33, y: 47 }, { dx: 0, dy: 0 })).toEqual({ x: 40, y: 40 });
  expect(dropPlace({ x: 12.4, y: 7.6 }, { dx: 0.2, dy: 0 }, true)).toEqual({ x: 13, y: 8 });
  /* The node schema's bounds: -10,000 to 20,000, on the grid at both ends. */
  expect(dropPlace({ x: 19_990, y: -9_995 }, { dx: 100, dy: -100 })).toEqual({ x: 20_000, y: -10_000 });
  expect(dropPlace({ x: 19_990, y: -9_995 }, { dx: 100, dy: -100 }, true)).toEqual({ x: 20_000, y: -10_000 });
  expect([clampPosition(-99_999), clampPosition(99_999), clampPosition(5)]).toEqual([-10_000, 20_000, 5]);
  /* While dragging, the card is drawn where it will land. */
  expect(dragShown({ x: 100, y: 100 }, { dx: 59, dy: 39 })).toEqual({ dx: 60, dy: 40 });
  expect(dragShown({ x: 100, y: 100 }, { dx: 59, dy: 39 }, true)).toEqual({ dx: 59, dy: 39 });
  expect(dragShown({ x: 33, y: 47 }, { dx: 2, dy: -3 })).toEqual({ dx: 7, dy: -7 });
});

/* ── Sections ─────────────────────────────────────────────────────────── */

test("sections: every card sits in its kind's section, in board order, unless a person filed it under a section title", () => {
  const nodes = [
    card("mira", "character", { assetId: "face" }), card("dunes", "element", { assetId: "plate" }), card("sphere", "element"), card("board", "media", { assetId: "frame" }),
    card("look", "moodboard"), card("brief", "brief"), card("say", "note"), card("s1", "scene"), card("s2", "generate"), card("tone", "grade"),
    card("mix", "merge"), card("out", "output"), card("check", "verify" as NodeType), card("lamp", "media", { refKind: "element" }),
  ];
  expect(nodes.map((n) => boardGroupOf(n, assets))).toEqual(["cast", "environment", "element", "ref", "look", "direction", "direction", "shots", "shots", "finishing", "finishing", "output", "other", "element"]);
  const sections = boardSections(nodes, assets);
  expect(sections.map((s) => [s.title, ids(s.members)])).toEqual([
    ["Cast", ["mira"]], ["Environment", ["dunes"]], ["Elements", ["sphere", "lamp"]], ["Refs", ["board"]], ["Looks", ["look"]], ["Direction", ["brief", "say"]],
    ["Shots", ["s1", "s2"]], ["Finishing", ["tone", "mix"]], ["Review and output", ["out"]], ["Other cards", ["check"]],
  ]);
  /* A kind's section has one id everywhere (so it is made once), and no title card until a Tidy makes it. */
  expect(sections.map((s) => s.id)).toEqual(sections.map((s) => kindSectionId(s.group!)));
  expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  expect(sections.every((s) => s.card === null)).toBe(true);
  expect(sectionGroup(CAST)).toBe("cast");
  expect(sectionGroup("sec-1")).toBeNull();
  expect(kindSectionId("cast")).toMatch(/^node-[0-9a-f]{16}$/);

  /* Titles on the board: a kind's (renamed by a person), and two a person made. A card filed under one sits there. */
  const board = [
    ...nodes.filter((n) => ["mira", "board", "s1", "s2"].includes(n.id)),
    title(CAST, "Principal cast"), title("sec-1", "Scene 1 · Harbour"), title("sec-2", "Later"),
  ];
  board[3] = { ...board[3], section: "sec-1" };
  /* Filed under a title that is not on the board (taken off): it follows its kind again. */
  board[0] = { ...board[0], section: "gone" };
  const filed = boardSections(board, assets);
  expect(filed.map((s) => [s.title, ids(s.members), s.card?.id ?? null])).toEqual([
    ["Principal cast", ["mira"], CAST],
    ["Refs", ["board"], null],
    ["Shots", ["s1"], null],
    /* A person's section sits just after the kind of card it holds... */
    ["Scene 1 · Harbour", ["s2"], "sec-1"],
    /* ...and at the end while it holds nothing. */
    ["Later", [], "sec-2"],
  ]);
  /* A section title is never a member of anything. */
  expect(filed.flatMap((s) => s.members).some(isSectionNode)).toBe(false);
});

test("a section title is a note in section mode: never wired, named a Section, and older releases read it as a note", () => {
  const nodes = [title("sec", "Cast"), card("mira", "character"), card("s1", "scene"), card("say", "note")];
  expect(isSectionNode(nodes[0])).toBe(true);
  expect(isSectionNode(card("say", "note"))).toBe(false);
  expect(isSectionNode(card("say", "note", { mode: "Image" }))).toBe(false);
  expect(canConnect(nodes, "sec", "s1")).toBe("Section titles group cards on the board. They do not connect to other cards.");
  expect(canConnect(nodes, "mira", "sec")).toBe("Section titles group cards on the board. They do not connect to other cards.");
  expect(canConnect(nodes, "say", "s1")).toBeNull();
  expect(cardLabel(nodes[0], { assets: [] })).toBe("Section");
  expect(cardLabel(nodes[3], { assets: [] })).toBe("Direction");
  /* Its box: as wide as it was laid out (within bounds), and one short row tall. */
  expect([cardWidth(title("a", "A", { width: 820 })), cardWidth(title("a", "A", { width: 9000 })), cardWidth(title("a", "A", { width: 150 }))]).toEqual([820, 1200, 220]);
  expect(cardHeight(nodes[0])).toBe(CARD_HEIGHT.section);
  /* The node schema has held `mode` as a free string all along. */
  expect(canvasNodeSchema.parse(nodes[0])).toEqual(nodes[0]);
});

/* ── Filing by letting a card go under a title ─────────────────────────── */

test("filing: a card let go under a section title joins it; its own kind's title clears the filing; anywhere else nothing changes", () => {
  const nodes = [
    title(CAST, "Cast", { x: 60, y: 60 }), card("mira", "character", { x: 60, y: 140 }),
    title("sec-1", "Scene 1", { x: 420, y: 60 }), card("s2", "scene", { x: 420, y: 140, section: "sec-1" }),
    card("board", "media", { x: 1500, y: 1500 }), card("jonah", "character", { x: 1500, y: 2000, section: "sec-1" }),
  ];
  /* Under Cast (a Ref): filed there. Under Scene 1: filed there. */
  expect(sectionAt(nodes, assets, "board", { x: 60, y: 400 })?.id).toBe(CAST);
  expect(filingAt(nodes, assets, "board", { x: 60, y: 400 })).toEqual({ section: CAST });
  expect(filingAt(nodes, assets, "board", { x: 400, y: 300 })).toEqual({ section: "sec-1" });
  /* Too far below the section's cards, or under no title: unchanged. */
  const floor = 140 + CARD_HEIGHT.reference + 240;
  expect(filingAt(nodes, assets, "board", { x: 60, y: floor })).toEqual({ section: CAST });
  expect(filingAt(nodes, assets, "board", { x: 60, y: floor + 20 })).toBeNull();
  expect(filingAt(nodes, assets, "board", { x: 1200, y: 140 })).toBeNull();
  /* Above a title is not under it. */
  expect(filingAt(nodes, assets, "board", { x: 60, y: 20 })).toBeNull();
  /* A Cast card under Cast: its own kind's section, nothing to file. A Cast card filed elsewhere comes back to its kind. */
  expect(filingAt(nodes, assets, "mira", { x: 60, y: 400 })).toBeNull();
  expect(filingAt(nodes, assets, "jonah", { x: 60, y: 400 })).toEqual({ section: undefined });
  /* Already filed there: nothing changes. */
  expect(sectionAt(nodes, assets, "s2", { x: 420, y: 300 })?.id).toBe("sec-1");
  expect(filingAt(nodes, assets, "s2", { x: 420, y: 300 })).toBeNull();
  /* Two titles in one column: the nearest above wins. */
  const stacked = [...nodes, title("sec-3", "Pickups", { x: 60, y: 420 })];
  expect(sectionAt(stacked, assets, "board", { x: 60, y: 500 })?.id).toBe("sec-3");
  expect(sectionAt(stacked, assets, "board", { x: 60, y: 300 })?.id).toBe(CAST);
  /* A section title is never filed, and a card that is gone is never filed. */
  expect(filingAt(nodes, assets, CAST, { x: 420, y: 300 })).toBeNull();
  expect(filingAt(nodes, assets, "nobody", { x: 60, y: 300 })).toBeNull();
});

test("dropCard: lands on the grid (or exactly, with Alt), files under the title it lands under, and refuses a locked or missing card", () => {
  const p = project([title(CAST, "Cast", { x: 60, y: 60 }), card("mira", "character", { x: 60, y: 140 }), card("board", "media", { x: 1500, y: 1500 }), card("lock", "media", { x: 700, y: 700, locked: true })]);
  const moved = dropCard(p, "board", { dx: -1438, dy: -1103 });
  expect(moved.nodes.find((n) => n.id === "board")).toMatchObject({ x: 60, y: 400, section: CAST });
  const free = dropCard(p, "board", { dx: -1438, dy: -1103 }, true);
  expect(free.nodes.find((n) => n.id === "board")).toMatchObject({ x: 62, y: 397, section: CAST });
  /* Back out to open board: it keeps its filing (only a title's column changes it). */
  const out = dropCard(moved, "board", { dx: 1440, dy: 1100 });
  expect(out.nodes.find((n) => n.id === "board")).toMatchObject({ x: 1500, y: 1500, section: CAST });
  /* Under its own kind's title a card follows its kind: the filing goes. */
  const back = dropCard({ ...moved, nodes: moved.nodes.map((n) => (n.id === "mira" ? { ...n, section: "elsewhere" } : n)) }, "mira", { dx: 0, dy: 20 });
  expect("section" in back.nodes.find((n) => n.id === "mira")!).toBe(false);
  /* Nothing moved and nothing filed: the same draft. */
  expect(dropCard(p, "board", { dx: 3, dy: -4 })).toBe(p);
  expect(() => dropCard(p, "lock", { dx: 100, dy: 0 })).toThrow("Unlock this card before moving it.");
  expect(() => dropCard(p, "gone", { dx: 100, dy: 0 })).toThrow("That card is no longer on the board.");
});

/* ── Adding and editing on the board ──────────────────────────────────── */

test("notes and section titles are added on the grid at an open spot, and their words are edited on the board", () => {
  const p = project([card("s1", "scene", { x: 100, y: 100 })]);
  /* Asked for where the shot is: the grid's (100, 100) is taken, so one step down and right. */
  const withNote = addBoardCard(p, "note", { x: 101, y: 93 }, "note-1");
  const note = withNote.nodes.at(-1)!;
  expect(note).toMatchObject({ id: "note-1", type: "note", title: "Note", text: "", x: 140, y: 140, width: 254, linked: [] });
  expect(isSectionNode(note)).toBe(false);
  /* A second at the same place steps down and right: two never stack. */
  const again = addBoardCard(withNote, "section", { x: 138, y: 139 }, "sec-1");
  expect(again.nodes.at(-1)).toEqual({ id: "sec-1", title: "New section", type: "note", mode: "section", x: 180, y: 180, width: 260, linked: [] });
  expect(freeSpot(again.nodes, { x: 140, y: 140 })).toEqual({ x: 220, y: 220 });
  /* The same id twice is one card; every card made is valid for the draft save. */
  expect(addBoardCard(again, "note", { x: 0, y: 0 }, "note-1")).toBe(again);
  expect(saveSchema.safeParse({ project: again, revision: 0 }).success).toBe(true);

  const written = withBoardText(again, "note-1", "text", "Hold the frame.\nLet the fabric move.  \n");
  expect(written.nodes.find((n) => n.id === "note-1")!.text).toBe("Hold the frame.\nLet the fabric move.");
  const named = withBoardText(written, "sec-1", "title", "  Scene 1 ·   Harbour ");
  expect(named.nodes.find((n) => n.id === "sec-1")!.title).toBe("Scene 1 · Harbour");
  expect(withBoardText(named, "sec-1", "title", "Scene 1 · Harbour")).toBe(named);
  expect(() => withBoardText(named, "sec-1", "title", "   ")).toThrow("Give the section a name.");
  expect(() => withBoardText(named, "sec-1", "title", "x".repeat(301))).toThrow("at most 300 characters");
  expect(() => withBoardText(named, "note-1", "text", "x".repeat(30_001))).toThrow("at most 30,000 characters");
  expect(() => withBoardText({ ...named, nodes: named.nodes.map((n) => ({ ...n, locked: true })) }, "note-1", "text", "x")).toThrow("Unlock this card before editing it.");
  expect(() => withBoardText(named, "gone", "text", "x")).toThrow("That card is no longer on the board.");
  /* Only the field edited travels to the team canvas. */
  expect(diffForTeam(written, named, 5)!.fields).toEqual({ "sec-1": ["title"] });
});

/* ── What a card says at a glance ─────────────────────────────────────── */

test("a card says its state: a shot's as the shot list reads it, a reference's by its source, nothing for a note", () => {
  const shot = card("s1", "scene", { role: "Director" });
  expect(["approved", "queued", "ready", "failed", "draft"].map((s) => { const c = cardStatus(shot, s, false); return [c.word, c.tone, c.detail]; })).toEqual([
    ["Approved", "green", "Director"], ["Rendering", "gold", "Director"], ["Ready", "gold", "Director"], ["Failed", "red", "Director"], ["Draft", "floor", "Director"],
  ]);
  /* A failed take never claims what was billed: that is the Takes page's to say, from the provider's own outcome. */
  expect(cardStatus(shot, "failed", true).word).toBe("Failed");
  expect(cardStatus(card("mira", "character"), undefined, true)).toEqual({ word: "Ready", tone: "gold", detail: "Costume stylist" });
  expect(cardStatus(card("mira", "character"), undefined, false)).toEqual({ word: "No source yet", tone: "floor", detail: "Costume stylist" });
  expect(cardStatus(card("mira", "character", { status: "approved" }), undefined, true).word).toBe("Approved");
  expect(cardStatus(card("say", "note", { role: "Director" }), undefined, false)).toEqual({ word: null, tone: "floor", detail: "Director" });
  expect(cardStatus(card("tone", "grade"), undefined, true)).toEqual({ word: null, tone: "blue", detail: "1 active tool" });
  expect(cardStatus(card("out", "output", { status: "review" }), undefined, true)).toEqual({ word: "In review", tone: "gold", detail: "Editor" });
  expect(cardStatus(card("mix", "merge"), undefined, false).word).toBe("Draft");
  expect(cardStatus(card("check", "verify" as NodeType), undefined, false)).toEqual({ word: "Draft", tone: "floor", detail: null });
});

/* ── Tidy by sections ─────────────────────────────────────────────────── */

test("tidy: a block of columns per section under its title, in board order, rows in canvas order, everything on the grid", () => {
  const cast = Array.from({ length: 6 }, (_, i) => card(`c${i + 1}`, "character", { x: 5000 - i * 37, y: 900 + i * 13 }));
  const nodes = [card("s1", "scene", { x: 900, y: 700 }), ...cast, card("board", "media", { x: 3, y: 7 }), card("s2", "scene", { x: 100, y: 1200, linked: ["s1"] }), card("say", "note", { x: 1234, y: 55 })];
  const { plan, nodes: laid } = tidied(nodes);
  const at = (id: string) => laid.find((n) => n.id === id)!;
  /* Cast first: six at five a column is three and three, under a title spanning both columns. */
  expect(plan.made.map((t) => [t.title, t.x, t.y, t.width])).toEqual([
    ["Cast", 60, 60, 540], ["Refs", 700, 60, 260], ["Direction", 1060, 60, 260], ["Shots", 1420, 60, 260],
  ]);
  expect(plan.made.every((t) => isSectionNode(t) && t.linked.length === 0 && t.id === kindSectionId(sectionGroup(t.id)!))).toBe(true);
  const cardRow = (h: number) => Math.ceil((h + TIDY.rowGap) / 20) * 20;
  expect(cast.map((c) => [at(c.id).x, at(c.id).y])).toEqual([
    [60, 140], [60, 140 + cardRow(CARD_HEIGHT.reference)], [60, 140 + 2 * cardRow(CARD_HEIGHT.reference)],
    [340, 140], [340, 140 + cardRow(CARD_HEIGHT.reference)], [340, 140 + 2 * cardRow(CARD_HEIGHT.reference)],
  ]);
  expect([at("board").x, at("board").y]).toEqual([700, 140]);
  expect([at("say").x, at("say").y]).toEqual([1060, 140]);
  /* Shots in canvas order, down one column. */
  expect([[at("s1").x, at("s1").y], [at("s2").x, at("s2").y]]).toEqual([[1420, 140], [1420, 140 + cardRow(CARD_HEIGHT.scene)]]);
  expect(laid.every((n) => n.x % 20 === 0 && n.y % 20 === 0)).toBe(true);
  expect(overlapping(laid)).toEqual([]);
  /* A second Tidy of the tidied board changes nothing and makes nothing. */
  const second = tidyBoard(laid, assets);
  expect(second.made).toEqual([]);
  expect(second.spots.filter((s) => { const n = laid.find((m) => m.id === s.id)!; return n.x !== s.x || n.y !== s.y || (s.width !== undefined && s.width !== n.width); })).toEqual([]);
});

test("tidy: a person's sections sit by what they hold, titles keep their names and get their columns' width, and sections wrap into bands", () => {
  const shots = Array.from({ length: 12 }, (_, i) => card(`s${i + 1}`, "scene", { section: i < 7 ? "sec-1" : "sec-2" }));
  const nodes = [title("sec-2", "Scene 2 · Night"), ...shots, title("sec-1", "Scene 1 · Day"), card("s0", "scene"), title(CAST, "Principal cast", { width: 999 })];
  const { plan, nodes: laid } = tidied(nodes);
  const at = (id: string) => laid.find((n) => n.id === id)!;
  /* Cast (a title with nothing in it), then Shots, then the scenes in the order they were made. */
  expect(boardSections(laid, assets).map((s) => s.title)).toEqual(["Principal cast", "Shots", "Scene 2 · Night", "Scene 1 · Day"]);
  expect(plan.made.map((t) => t.title)).toEqual(["Shots"]);
  expect([at(CAST).x, at(CAST).y, at(CAST).width, at(CAST).title]).toEqual([60, 60, 260, "Principal cast"]);
  expect([at(SHOTS).x, at("s0").x]).toEqual([420, 420]);
  /* Scene 2 holds five shots: one column. Scene 1 holds seven: two columns of four and three, and its title spans them. */
  expect([at("sec-2").x, at("sec-2").width]).toEqual([780, 260]);
  expect([at("sec-1").x, at("sec-1").width]).toEqual([1140, 540]);
  expect(["s1", "s4", "s5", "s7"].map((id) => [at(id).x, at(id).y])).toEqual([[1140, 140], [1140, 920], [1420, 140], [1420, 660]]);
  expect(overlapping(laid)).toEqual([]);

  /* Wider than a band: the next section starts a band below the tallest block. */
  const many = [...Array.from({ length: 40 }, (_, i) => card(`m${i}`, "media")), ...Array.from({ length: 30 }, (_, i) => card(`e${i}`, "element")), ...Array.from({ length: 25 }, (_, i) => card(`k${i}`, "character"))];
  const banded = tidied(many).nodes;
  const top = (group: "cast" | "element" | "ref") => banded.find((n) => n.id === kindSectionId(group))!;
  expect([top("cast").x, top("cast").y]).toEqual([60, 60]);
  expect(top("element").y).toBe(60);
  expect(top("ref").x).toBe(60);
  expect(top("ref").y).toBeGreaterThan(60 + TIDY.titleSlot + 5 * 240);
  expect(Math.max(...banded.map((n) => n.x + cardWidth(n)))).toBeLessThanOrEqual(TIDY.left + 3600);
  expect(overlapping(banded)).toEqual([]);
});

test("tidy: locked cards and cards this Tidy may not move keep their place; the rest step down past them", () => {
  const nodes = [card("a", "scene"), card("b", "scene"), card("lock", "scene", { x: 60, y: 300, locked: true }), card("theirs", "character", { x: 0, y: 0 })];
  /* Only a, b and the titles are this writer's to move (an Atomik run's own cards, say). */
  const movable = (n: CanvasNode) => !n.locked && n.id !== "theirs";
  const { plan, nodes: laid } = tidied(nodes, { movable });
  const at = (id: string) => laid.find((n) => n.id === id)!;
  expect([at("lock").x, at("lock").y, at("theirs").x, at("theirs").y]).toEqual([60, 300, 0, 0]);
  expect(plan.spots.map((s) => s.id).sort()).toEqual(["a", "b"]);
  /* Cast holds only a card that stays put: no title is made over it. Shots' title steps clear below the card in its way,
     and its cards step down past the locked shot, in order. */
  expect(plan.made.map((t) => [t.id, t.x, t.y])).toEqual([[SHOTS, 60, 240]]);
  expect([at("a").x, at("a").y, at("b").x, at("b").y]).toEqual([60, 560, 60, 820]);
  expect(overlapping(laid)).toEqual([]);
  expect(laid.every((n) => ["lock", "theirs"].includes(n.id) || (n.x % 20 === 0 && n.y % 20 === 0))).toBe(true);
  /* A title a person took off is never made again: its cards keep their block, untitled. */
  const untitled = tidyBoard(nodes, assets, { movable, canMake: (id) => id !== SHOTS });
  expect(untitled.made).toEqual([]);
  expect(untitled.spots.map((s) => [s.id, s.x, s.y])).toEqual([["a", 60, 560], ["b", 60, 820]]);
});

test("tidy: a feature-sized board fits the canvas: columns grow taller and bands wider until it does, with nothing overlapping", () => {
  const nodes = [
    ...Array.from({ length: 1500 }, (_, i) => card(`s${i}`, "scene")),
    ...Array.from({ length: 900 }, (_, i) => card(`m${i}`, "media")),
    ...Array.from({ length: 60 }, (_, i) => card(`c${i}`, "character")),
  ];
  const started = Date.now();
  const { nodes: laid } = tidied(nodes);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(Math.max(...laid.map((n) => n.x + cardWidth(n)))).toBeLessThanOrEqual(20_000);
  expect(Math.max(...laid.map((n) => n.y + cardHeight(n)))).toBeLessThanOrEqual(20_000);
  /* Overlap by grid cells, since a pairwise check of 2,400 cards is slow: no two cards share a 20 px cell. */
  const cells = new Map<string, string>();
  const clash: string[] = [];
  for (const n of laid) for (let x = n.x; x < n.x + cardWidth(n); x += 20) for (let y = n.y; y < n.y + cardHeight(n); y += 20) {
    const key = `${x},${y}`, was = cells.get(key);
    if (was && clash.length < 3) clash.push(`${was}×${n.id}`);
    cells.set(key, n.id);
  }
  expect(clash).toEqual([]);
});

/* ── The server's Tidy (the #466 ops tidy branch) ─────────────────────── */

const canvasOf = (nodes: CanvasNode[], extra: Partial<TeamCanvas> = {}): TeamCanvas =>
  ({ ...applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: assets.assets, order: ids(nodes), at: 1, author: "ana" }), ...extra });

test("the server's Tidy lays the team canvas out by sections, makes the titles it lacks as cards, and a second Tidy changes nothing", () => {
  const canvas = canvasOf([card("mira", "character", { x: 700, y: 900 }), card("s1", "scene", { x: 900, y: 700 }), card("s2", "scene", { x: 100, y: 1200, linked: ["s1"] })]);
  const plan = planCanvasOps(canvas, [{ kind: "tidy" }], "ana");
  expect(plan.outcomes).toEqual([{ kind: "create", nodeIds: [CAST, SHOTS] }, { kind: "tidy", nodeIds: ["mira", "s1", "s2"] }]);
  expect(plan.patch.made).toEqual([CAST, SHOTS]);
  expect(plan.patch.fields).toEqual({ mira: ["x", "y"], s1: ["x", "y"], s2: ["x", "y"] });
  const after = applyTeamPatch(canvas, { ...plan.patch, at: 5, author: "ana" });
  expect([after.nodes.mira.x, after.nodes.mira.y, after.nodes.s1.x, after.nodes.s1.y]).toEqual([60, 140, 420, 140]);
  expect(after.nodes[CAST]).toMatchObject({ title: "Cast", type: "note", mode: "section", x: 60, y: 60, width: 260 });
  expect(after.order).toEqual(["mira", "s1", "s2", CAST, SHOTS]);
  for (const n of Object.values(after.nodes)) expect(canvasNodeSchema.safeParse(n).success).toBe(true);
  expect(planCanvasOps(after, [{ kind: "tidy" }], "ana").changes).toEqual([]);
  /* A person renames and moves a title: the next Tidy keeps the name and puts the title back over its cards. */
  const renamed = applyTeamPatch(after, { upsertNodes: [{ ...after.nodes[CAST], title: "Principal cast", x: 3000 }], fields: { [CAST]: ["title", "x"] }, removeNodes: [], upsertAssets: [], order: null, at: 6, author: "bo" });
  const again = planCanvasOps(renamed, [{ kind: "tidy" }], "ana");
  expect(again.outcomes).toEqual([{ kind: "tidy", nodeIds: [CAST] }]);
  expect(applyTeamPatch(renamed, { ...again.patch, at: 7, author: "ana" }).nodes[CAST]).toMatchObject({ title: "Principal cast", x: 60, y: 60 });
  /* A title a person took off the board is never made again by a Tidy. */
  const taken = applyTeamPatch(after, { upsertNodes: [], removeNodes: [SHOTS], upsertAssets: [], order: null, at: 8, author: "bo" });
  const untitled = planCanvasOps(taken, [{ kind: "tidy" }], "ana");
  expect(untitled.patch.made).toEqual([]);
  expect(untitled.outcomes).toEqual([{ kind: "tidy", nodeIds: [] }]);
});

test("an Atomik run's tidy lays out only its own cards, by section, and makes no title; its undo takes off just its build, and a person's Tidy makes the titles", () => {
  const RUN = "agent:run-1";
  let canvas = canvasOf([card("person", "scene")]);
  /* One batch through the ops model, recorded as applyCanvasOps records it: the cards it made are the server's. */
  const step = (ops: CanvasOp[], author: string, at: number) => {
    const plan = planCanvasOps(canvas, ops, author);
    canvas = applyTeamPatch(canvas, { ...plan.patch, at, author });
    for (const change of plan.changes) if (change.made && canvas.nodes[change.id]) canvas.serverMade[change.id] = author;
    return plan;
  };
  /* The run builds a cast card and a shot (lib/workbench/rig-agent-plan.ts places them clear, to the right). */
  step([{ kind: "create", node: card("mine", "scene", { x: 3000, y: 3000 }) }, { kind: "create", node: card("lead", "character", { x: 3000, y: 3400 }) }], RUN, 2);
  /* Its tidy moves only its own cards, into their sections' blocks, clear of the person's shot; it makes no title, so
     the board holds exactly the cards the person approved. */
  const tidy = step([{ kind: "tidy", nodeIds: ["mine", "lead"] }], RUN, 3);
  expect(tidy.outcomes).toEqual([{ kind: "tidy", nodeIds: ["lead", "mine"] }]);
  expect(tidy.patch.made).toEqual([]);
  expect([canvas.nodes.person.x, canvas.nodes.person.y]).toEqual([0, 0]);
  expect(canvas.nodes.lead.x).toBeLessThan(canvas.nodes.mine.x);
  expect([canvas.nodes.lead.x % BOARD_GRID, canvas.nodes.lead.y % BOARD_GRID, canvas.nodes.mine.x % BOARD_GRID, canvas.nodes.mine.y % BOARD_GRID]).toEqual([0, 0, 0, 0]);
  expect(overlapping(Object.values(canvas.nodes))).toEqual([]);
  /* Its undo takes off its build and nothing else: the person's shot stays. */
  expect(step(undoOps(canvas, RUN, []), RUN, 4).outcomes).toEqual([{ kind: "remove", nodeIds: ["mine", "lead"] }]);
  expect(Object.keys(canvas.nodes)).toEqual(["person"]);
  /* A person's Tidy makes the title over their own shot. */
  expect(step([{ kind: "tidy" }], "ana", 5).outcomes).toEqual([{ kind: "create", nodeIds: [SHOTS] }, { kind: "tidy", nodeIds: ["person"] }]);
  expect(canvas.nodes[SHOTS]).toMatchObject({ title: "Shots", type: "note", mode: "section" });
  /* A later run tidies its card under that title (the title is the person's: the run neither moves nor remakes it). */
  step([{ kind: "create", node: card("second", "scene", { x: 3000, y: 3000 }) }], "agent:run-2", 6);
  expect(step([{ kind: "tidy" }], "agent:run-2", 7).outcomes).toEqual([{ kind: "tidy", nodeIds: ["second"] }]);
  expect(canvas.nodes[SHOTS]).toMatchObject({ x: 60, y: 60 });
  expect(overlapping(Object.values(canvas.nodes))).toEqual([]);
});

/* ── The one new field, through the schema, the team canvas and the merge ── */

test("a card's filing is declared in the node schema and kept by the draft save, the team canvas patch and a merge", async () => {
  const filed = card("s2", "scene", { section: "sec-1" });
  expect(canvasNodeSchema.parse(filed)).toEqual(filed);
  expect(canvasNodeSchema.safeParse({ ...filed, section: "" }).success).toBe(false);
  expect(canvasNodeSchema.safeParse({ ...filed, section: "x".repeat(101) }).success).toBe(false);
  const draft = project([title("sec-1", "Scene 1"), filed]);
  expect(saveSchema.parse({ project: draft, revision: 0 }).project.nodes[1]).toEqual(filed);

  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const store = await import("../../lib/workbench/team-canvas");
  const ws = { id: "board", name: "board", slug: "board", dbUrl: `file:${path.join(dir, "board.db")}`, legacy: false, dbToken: null, keys: {}, storageQuotaBytes: 10, usesPlatformKeys: false } as TenantWorkspace;
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES('prod-board','Board',0)", args: [] });
    /* The route's own path: parsed, then folded in. */
    const body = store.teamPatchSchema.parse({ productionId: "prod-board", upsertNodes: draft.nodes, removeNodes: [], upsertAssets: [], order: ["sec-1", "s2"] });
    const { productionId, ...patch } = body;
    await store.patchTeamCanvas(productionId, patch, "ana");
    /* A teammate moves the card: the filing stays. */
    await store.patchTeamCanvas(productionId, store.teamPatchSchema.parse({ productionId, upsertNodes: [{ ...card("s2", "scene"), x: 400 }], fields: { s2: ["x"] }, removeNodes: [], upsertAssets: [], order: null }), "bo");
    const read = (await store.readTeamCanvas("prod-board"))!;
    expect(read.canvas.nodes.s2).toEqual({ ...filed, x: 400 });
    expect(read.canvas.nodes["sec-1"]).toEqual(title("sec-1", "Scene 1"));
  });
  const canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: draft.nodes, removeNodes: [], upsertAssets: [], order: ["sec-1", "s2"], at: 1 });
  expect(parseTeamCanvas(JSON.parse(JSON.stringify(canvas))).nodes.s2).toEqual(filed);
  expect(withTeamCanvas(project([]), canvas).nodes.map((n) => n.section ?? null)).toEqual([null, "sec-1"]);
  /* Only the filing travels when it changes; a merge keeps mine and a teammate's move together. */
  const base = project([title("sec-1", "Scene 1"), card("s2", "scene")]);
  expect(diffForTeam(base, draft, 3)!.fields).toEqual({ s2: ["section"] });
  const theirs = { ...base, nodes: [base.nodes[0], { ...base.nodes[1], x: 640 }] };
  expect(mergeDraft(base, draft, theirs).nodes[1]).toMatchObject({ x: 640, section: "sec-1" });
});

/* ── The phone's flow ─────────────────────────────────────────────────── */

test("the phone's flow reads section by section after the scene and its wires; a board with no titles reads as before", () => {
  const plain = [card("m", "media"), card("s1", "scene", { linked: ["m"] }), card("mira", "character"), card("board", "media"), card("s2", "scene")];
  expect(sectionedFlow(flowChain(plain, "s1"), plain, assets)).toEqual(flowChain(plain, "s1"));
  const nodes = [...plain, title("sec-1", "Scene 2"), title(REFS, "Refs")];
  nodes[4] = { ...nodes[4], section: "sec-1" };
  const flow = sectionedFlow(flowChain(nodes, "s1"), nodes, assets);
  /* The scene's input and the scene; then Cast (no title yet), Refs under its title, and Scene 2 under its own. */
  expect(flow.map((s) => s.id)).toEqual(["m", "s1", "mira", REFS, "board", "sec-1", "s2"]);
  expect(flow.map((s) => s.wire)).toEqual(["blue", "grey", "grey", "grey", "grey", "grey", null]);
  expect(flow.filter((s) => s.scene).map((s) => s.id)).toEqual(["s1"]);
  expect(BOARD_GROUP_TITLES.ref).toBe("Refs");
  /* The graph draws every card, titles included, from the same positions. */
  expect(graphLayout(nodes).cards.map((c) => c.id)).toEqual(ids(nodes));
});
