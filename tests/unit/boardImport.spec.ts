import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { BoardNode, BoardWire } from "../../lib/boards";
import type { Asset, CanvasNode } from "../../lib/workbench/studio";
import { canvasNodeSchema } from "../../lib/workbench/studio-schema";
import { cardLabel, refKindOf } from "../../lib/workbench/ref-kind";
import { applyTeamPatch, emptyTeamCanvas, withTeamCanvas, type TeamCanvas } from "../../lib/workbench/team-canvas-model";
import { PROJECT_LIMITS } from "../../lib/workbench/project-limits";
import {
  boardPlacement, cardStates, importedNodeId, importedShape, importSummary, mapBoardNode, mediaCandidates, mediaOfUrl,
  planBoardImport, readBoardGraph, PLACE_GAP, type ImportContext, type ImportCounts, type ImportElement,
} from "../../lib/workbench/board-import-model";
import { IMPORT_FAILED, importBatch, importCopy, importedBoardOf, importParam, isImportAnswer, newRigFor, newRigHref, withoutImport } from "../../lib/workspace/rig-import";

/*
 * Opening an old Rig board in the new Rig (the agentic canvas plan, PR 6): the
 * mapping of every old card kind, stable ids, where the board lands, one
 * bounded batch at a time through applyCanvasOps, importing again (nothing
 * twice; only what is new; what a person took off or unwired stays so), the
 * old board untouched, and what the Rig says. Local databases only; no live
 * room (the unit process has no Liveblocks key), no provider, nothing paid.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-board-import-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
delete process.env.LIVEBLOCKS_SECRET_KEY;

function workspace(name: string): TenantWorkspace {
  return { id: "ws_" + name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}

/** An old board's card and wire, as lib/boards.ts stores them. */
const card = (id: string, kind: string, x: number, y: number, extra: Partial<BoardNode> = {}): BoardNode =>
  ({ id, kind: kind as BoardNode["kind"], x, y, label: kind, ref: null, ports: [], inputs: [], output: null, settings: {}, state: "idle", credits: 0, staleSince: null, ...extra });
const wire = (id: string, from: string, to: string, slotId: string, kind: BoardWire["kind"] = "inherited"): BoardWire =>
  ({ id, from: { nodeId: from, portId: "out" }, to: { nodeId: to, slotId }, kind });
const context = (extra: Partial<ImportContext> = {}): ImportContext => ({ boardId: "brd_one", boardName: "SH04 board", elements: new Map(), media: new Map(), ...extra });
const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });
const canvasOf = (nodes: CanvasNode[]): TeamCanvas => applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: nodes.map((n) => n.id), at: 1, author: "ana" });
const id = (nodeId: string, boardId = "brd_one") => importedNodeId(boardId, nodeId);

/* ── The mapping ──────────────────────────────────────────────────────── */

test("the mapping table: every old card kind becomes a new-Rig card, a reference with its kind", () => {
  const elements = new Map<string, ImportElement>([
    ["el_noor", { kind: "character", name: "Noor", description: "The lead, early thirties.", picture: { source: "upload", id: "up_face" } }],
    ["el_desert", { kind: "location", name: "Desert", description: "", picture: { source: "generation", id: "gen_plate" } }],
    ["el_bag", { kind: "prop", name: "The bag", description: "", picture: { source: "upload", id: "up_gone" } }],
    ["el_warm", { kind: "look", name: "Warm", description: "", picture: null }],
    ["el_voice", { kind: "voice", name: "Noor’s voice", description: "", picture: null }],
  ]);
  const media = new Map<string, Asset["kind"]>([["upload:up_face", "image"], ["generation:gen_plate", "image"], ["generation:gen_take", "video"], ["upload:up_ref", "image"]]);
  const ctx = context({ elements, media });
  type Row = [BoardNode, { type: CanvasNode["type"]; kind: string | null; label: string; asset?: string }];
  const table: Row[] = [
    [card("a1", "asset", 0, 0, { label: "@Noor", ref: { elementId: "el_noor" } }), { type: "character", kind: "cast", label: "Cast", asset: "up_face" }],
    [card("a2", "asset", 0, 0, { label: "@Desert", ref: { elementId: "el_desert" } }), { type: "element", kind: "environment", label: "Environment", asset: "gen_plate" }],
    [card("a3", "asset", 0, 0, { label: "@The bag", ref: { elementId: "el_bag" } }), { type: "element", kind: "element", label: "Element" }],
    [card("a4", "asset", 0, 0, { label: "@Warm", ref: { elementId: "el_warm" } }), { type: "moodboard", kind: null, label: "Look board" }],
    [card("a5", "asset", 0, 0, { label: "@Voice", ref: { elementId: "el_voice" } }), { type: "media", kind: "ref", label: "Ref" }],
    /* The element is gone from the library: the kind the old card kept says what it was. */
    [card("a6", "asset", 0, 0, { label: "@Harbour", ref: { elementId: "el_gone" }, settings: { kind: "location" } }), { type: "element", kind: "environment", label: "Environment" }],
    [card("a7", "asset", 0, 0, { label: "@Something" }), { type: "element", kind: "element", label: "Element" }],
    [card("s1", "shot", 0, 0, { label: "SH04", ref: { shotId: "shot_1" }, settings: { title: "The encounter" } }), { type: "scene", kind: null, label: "Scene" }],
    [card("p1", "prompt", 0, 0, { text: "Noor’s hands on the bag." }), { type: "note", kind: null, label: "Direction" }],
    [card("n1", "note", 0, 0, { label: "Note", text: "Hold the frame." }), { type: "note", kind: null, label: "Direction" }],
    [card("n2", "note", 0, 0, { label: "Rain.webp", text: "REF · Rain.webp", output: { url: "/api/uploads/up_ref", kind: "image" } }), { type: "media", kind: "ref", label: "Ref", asset: "up_ref" }],
    /* A reference that is no longer in the Library: the note stays a note, with no picture to break a save. */
    [card("n3", "note", 0, 0, { label: "Gone.webp", text: "REF · Gone.webp", output: { url: "/api/uploads/up_missing", kind: "image" } }), { type: "note", kind: null, label: "Direction" }],
    [card("i1", "image", 0, 0, { label: "Nano Banana Pro", ref: { engine: "gemini-3-pro-image" }, settings: { resolution: "2K", ratio: "9:16", prompt: "Warm window light" } }), { type: "generate", kind: null, label: "Generate" }],
    [card("v1", "video", 0, 0, { label: "Seedance 2.5", ref: { engine: "dreamina-seedance-2-5-260628" }, settings: { seconds: 10, resolution: "1080p", ratio: "16:9", prompt: "She turns", motion: "Push in, slow." }, output: { genId: "gen_take", url: "/api/media/gen_take", kind: "video", label: "SH04 v3", filedTo: { shotId: "shot_1", version: 3 } } }), { type: "generate", kind: null, label: "Generate", asset: "gen_take" }],
    [card("e1", "edit", 0, 0, { label: "Edit" }), { type: "media", kind: "ref", label: "Ref" }],
    [card("u1", "upscale", 0, 0, { label: "Topaz" }), { type: "media", kind: "ref", label: "Ref" }],
    [card("au1", "audio", 0, 0, { label: "Audio" }), { type: "media", kind: "ref", label: "Ref" }],
    [card("vo1", "voice", 0, 0, { label: "Voice" }), { type: "media", kind: "ref", label: "Ref" }],
    [card("c1", "compare", 0, 0, { label: "Compare" }), { type: "review", kind: null, label: "Review" }],
    /* A kind this release has never heard of: a Ref that says what it was. */
    [card("x1", "hologram", 0, 0, { label: "Hologram" }), { type: "media", kind: "ref", label: "Ref" }],
  ];
  for (const [old, want] of table) {
    const { node, asset } = mapBoardNode(old, ctx, { dx: 0, dy: 0 });
    const project = { assets: asset ? [asset] : [] };
    expect({ old: old.id, type: node.type, kind: refKindOf(node, project), label: cardLabel(node, project), asset: asset?.id }).toEqual({ old: old.id, type: want.type, kind: want.kind, label: want.label, asset: want.asset });
    /* Every card and picture is one the team canvas accepts, and says where it came from. */
    expect(canvasNodeSchema.safeParse(node).success, old.id).toBe(true);
    expect(node).toMatchObject({ id: id(old.id), linked: [], status: "draft", imported: { board: "brd_one", node: old.id, kind: old.kind, dx: 0, dy: 0, inputs: [] } });
    if (asset) expect(node.assetId).toBe(asset.id);
  }
  const byOld = Object.fromEntries(table.map(([old]) => [old.id, mapBoardNode(old, ctx, { dx: 0, dy: 0 })]));
  /* References keep their element: the master link a later step locks. */
  expect(byOld.a1.node).toMatchObject({ refKind: "cast", elementId: "el_noor", title: "@Noor", text: "The lead, early thirties.", imported: { element: "character" } });
  expect(byOld.a1.asset).toMatchObject({ id: "up_face", uploadId: "up_face", url: "/api/uploads/up_face", category: "Character", kind: "image" });
  expect(byOld.a2.asset).toMatchObject({ generationId: "gen_plate", url: "/api/media/gen_plate", category: "Environment" });
  expect(byOld.s1.node).toMatchObject({ title: "SH04 — The encounter", text: "The encounter", mode: "Video", imported: { shot: "shot_1" } });
  expect(byOld.i1.node).toMatchObject({ title: "Image · Nano Banana Pro", mode: "Image", engine: "gemini-3-pro-image", ratio: "9:16", resolution: "2K", text: "Warm window light" });
  expect(byOld.v1.node).toMatchObject({ title: "Video · Seedance 2.5", mode: "Video", durationS: 10, text: "She turns\nMotion: Push in, slow." });
  expect(byOld.v1.asset).toMatchObject({ id: "gen_take", kind: "video", category: "Shot", version: 3, nodeId: id("v1"), name: "SH04 v3" });
  expect(byOld.c1.node.verify).toEqual({});
  expect(byOld.u1.node).toMatchObject({ title: "Upscale · Topaz", text: "Upscale card from the old board. It never ran there." });
  expect(byOld.c1.node.text).toBe("Compare card from the old board (A and B). It never ran there.");
  /* A card that could not run on a board but holds a render all the same keeps it, and says nothing untrue about it. */
  const ran = mapBoardNode(card("u2", "upscale", 0, 0, { label: "Topaz", output: { genId: "gen_take", kind: "video" } }), ctx, { dx: 0, dy: 0 });
  expect([ran.node.text, ran.asset?.id, ran.asset?.nodeId]).toEqual(["Upscale card from the old board.", "gen_take", id("u2")]);
  expect(byOld.x1.node.text).toBe("A “hologram” card from the old board.");
  expect(byOld.p1.node).toMatchObject({ title: "Prompt", text: "Noor’s hands on the bag." });
  /* Only a picture that exists comes across: a draft save checks every media reference a card holds. */
  expect(byOld.a3.asset).toBeNull();
  expect(byOld.n3.asset).toBeNull();
  /* The shapes themselves, for the words the plan names. */
  expect(importedShape("asset", "character")).toEqual({ type: "character", refKind: "cast" });
  expect(importedShape("compare")).toEqual({ type: "review", verify: true });
  expect(importedShape("")).toEqual({ type: "media", refKind: "ref" });
  expect(mapBoardNode(card("q", 7 as unknown as string, 0, 0, { label: "" }), ctx, { dx: 0, dy: 0 }).node).toMatchObject({ type: "media", refKind: "ref", title: "Card", text: "A card from the old board, of a kind this release does not know." });
});

test("an image or video card that named no engine takes the workspace's default one, as the old board rendered it", () => {
  const ctx = context({ models: { image: "gemini-3.1-flash-image", video: "dreamina-seedance-2-0-260128" } });
  expect(mapBoardNode(card("i", "image", 0, 0), ctx, { dx: 0, dy: 0 }).node.engine).toBe("gemini-3.1-flash-image");
  expect(mapBoardNode(card("v", "video", 0, 0, { settings: { seconds: 99, ratio: "wide", resolution: "1080 p" } }), ctx, { dx: 0, dy: 0 }).node)
    .toMatchObject({ engine: "dreamina-seedance-2-0-260128" });
  /* Settings the new Rig cannot hold are left for it to fill, never sent broken. */
  const odd = mapBoardNode(card("v", "video", 0, 0, { settings: { seconds: 99, ratio: "wide", resolution: "1080 p" } }), ctx, { dx: 0, dy: 0 }).node;
  expect([odd.durationS, odd.ratio, odd.resolution]).toEqual([undefined, undefined, undefined]);
});

test("stable ids: an old card has the same id on every import, and another board's card another", () => {
  expect(importedNodeId("brd_one", "nd_a")).toBe(importedNodeId("brd_one", "nd_a"));
  expect(importedNodeId("brd_one", "nd_a")).not.toBe(importedNodeId("brd_two", "nd_a"));
  expect(importedNodeId("brd_one", "nd_a")).not.toBe(importedNodeId("brd_one", "nd_b"));
  expect(importedNodeId("brd_one", "nd_a")).toMatch(/^node-[0-9a-f]{16}$/);
  expect(mapBoardNode(card("nd_a", "note", 0, 0), context(), { dx: 0, dy: 0 }).node.id).toBe(importedNodeId("brd_one", "nd_a"));
});

test("an old board is read defensively: each card once, inputs as pairs with their slots, filing lines apart", () => {
  const graph = readBoardGraph({
    nodes: [card("a", "asset", 0, 0), card("s", "shot", 0, 0), card("s", "shot", 9, 9), card("i", "image", 0, 0), null, { id: 5 }, card("x".repeat(201), "note", 0, 0)],
    wires: [
      wire("w1", "a", "s", "character"),
      wire("w2", "a", "s", "prop", "override"),
      wire("w3", "s", "i", "spec"),
      wire("w4", "i", "s", "takes", "filed"),
      wire("w5", "a", "missing", "character"),
      wire("w6", "s", "s", "prompt"),
      { id: "w7" },
    ],
  });
  expect(graph.nodes.map((n) => [n.id, n.x])).toEqual([["a", 0], ["s", 0], ["i", 0]]);
  expect(graph.pairs).toEqual([{ from: "a", to: "s", slots: ["character", "prop"] }, { from: "s", to: "i", slots: ["spec"] }]);
  expect(graph.filed).toBe(1);
  expect(readBoardGraph({ nodes: "not json", wires: null })).toEqual({ nodes: [], pairs: [], filed: 0 });
  expect(mediaOfUrl("/api/uploads/up_1?x=1")).toEqual({ source: "upload", id: "up_1" });
  expect(mediaOfUrl("/api/media/gen%5F2")).toEqual({ source: "generation", id: "gen_2" });
  expect([mediaOfUrl("https://cdn.example/x.png"), mediaOfUrl("/api/uploads/a/b"), mediaOfUrl(3)]).toEqual([null, null, null]);
});

test("where the board lands: its old places on an empty canvas; beside the cards already there; and the same place every time after", () => {
  const nodes = [card("a", "asset", 100, 50), card("s", "shot", 400, 80)];
  expect(boardPlacement(emptyTeamCanvas(), "brd_one", nodes)).toEqual({ dx: 0, dy: 0 });
  const busy = canvasOf([scene("mine", { x: 900, y: 300 }), scene("theirs", { x: 60, y: 700 })]);
  const at = boardPlacement(busy, "brd_one", nodes);
  expect(at).toEqual({ dx: 900 + 238 + PLACE_GAP - 100, dy: 300 - 50 });
  /* Once the first cards came across, the placement they carry is the board's, whatever else moved since, even off the canvas. */
  const made = mapBoardNode(nodes[0], context(), at).node;
  const later = applyTeamPatch(busy, { upsertNodes: [made, scene("new", { x: 5000, y: -900 })], removeNodes: [], upsertAssets: [], order: null, at: 5, author: "ana" });
  expect(boardPlacement(later, "brd_one", nodes)).toEqual(at);
  const off = applyTeamPatch(later, { upsertNodes: [], removeNodes: [made.id], upsertAssets: [], order: null, at: 6, author: "ana" });
  expect(boardPlacement(off, "brd_one", nodes)).toEqual(at);
  expect(mapBoardNode(nodes[1], context(), at).node).toMatchObject({ x: 400 + at.dx, y: 80 + at.dy });
  /* Places out of range are kept inside the canvas's own. */
  expect(mapBoardNode(card("far", "note", 1e9, -1e9), context(), { dx: 0, dy: 0 }).node).toMatchObject({ x: 20000, y: -10000 });
});

/* ── Planning a batch (pure) ───────────────────────────────────────────── */

test("a batch: cards first, in board order, then the inputs between cards that are there; each handled input is recorded on its card", () => {
  const board = readBoardGraph({
    nodes: [card("a", "asset", 0, 0, { settings: { kind: "character" } }), card("s", "shot", 300, 0), card("i", "image", 600, 0), card("p", "prompt", 300, 300)],
    wires: [wire("w1", "a", "s", "character"), wire("w2", "s", "i", "spec"), wire("w3", "p", "i", "refs"), wire("w4", "i", "s", "takes", "filed")],
  });
  const ctx = context();
  const first = planBoardImport(emptyTeamCanvas(), board, ctx, "ana", { cards: 2, wires: 10 });
  /* Two cards (a, s) and the one input between them. */
  expect(first.ops.map((op) => op.kind)).toEqual(["create", "create", "wire"]);
  expect(first).toMatchObject({ cards: 2, wires: 1 });
  expect(first.opId).toMatch(/^import:brd_one:batch-[0-9a-f]{16}$/);
  const made = first.ops.filter((op): op is Extract<typeof op, { kind: "create" }> => op.kind === "create").map((op) => op.node);
  expect(made.find((n) => n.id === id("s"))!.imported!.inputs).toEqual([{ from: "a", slot: "character" }]);
  /* The same canvas and board give the same batch and the same op id. */
  expect(planBoardImport(emptyTeamCanvas(), board, ctx, "ana", { cards: 2, wires: 10 })).toEqual(first);
  /* After it lands, the next batch makes the rest and wires into a card that was already there with a record update. */
  const after = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: made.map((n) => (n.id === id("s") ? { ...n, linked: [id("a")] } : n)), made: made.map((n) => n.id), removeNodes: [], upsertAssets: [], order: null, at: 2, author: "ana" });
  const second = planBoardImport(after, board, ctx, "ana", { cards: 2, wires: 10 });
  expect(second.ops.map((op) => op.kind)).toEqual(["create", "create", "wire", "wire"]);
  expect(second.ops.filter((op) => op.kind === "wire")).toEqual([{ kind: "wire", from: id("s"), to: id("i") }, { kind: "wire", from: id("p"), to: id("i") }]);
  /* Filing lines are never inputs. */
  expect(JSON.stringify(second.ops)).not.toContain(`"from":"${id("i")}","to":"${id("s")}"`);
  expect(importSummary(after, board, { id: "brd_one", name: "SH04 board" })).toEqual({
    board: { id: "brd_one", name: "SH04 board" },
    cards: { total: 4, here: 2, off: 0, left: 2, refused: 0 },
    wires: { total: 3, here: 1, off: 0, left: 2, refused: 0 },
    filed: 1, done: false,
  });
});

test("an input the new Rig refuses for good (a loop) is noted on its card and never tried again; one into a locked card waits", () => {
  const board = readBoardGraph({
    nodes: [card("x", "note", 0, 0), card("y", "note", 300, 0), card("z", "note", 600, 0)],
    wires: [wire("w1", "x", "y", "text"), wire("w2", "y", "x", "text"), wire("w3", "x", "z", "text")],
  });
  const ctx = context();
  const made = planBoardImport(emptyTeamCanvas(), board, ctx, "ana", { cards: 10, wires: 0 }).ops.flatMap((op) => (op.kind === "create" ? [op.node] : []));
  let canvas = applyTeamPatch(emptyTeamCanvas(), { upsertNodes: made.map((n) => (n.id === id("z") ? { ...n, locked: true } : n)), made: made.map((n) => n.id), removeNodes: [], upsertAssets: [], order: null, at: 2, author: "ana" });
  const batch = planBoardImport(canvas, board, ctx, "ana");
  /* x→y links; y→x would close a loop (held, recorded); x→z waits for its locked card (not tried). */
  expect(batch.ops.filter((op) => op.kind === "wire")).toEqual([{ kind: "wire", from: id("x"), to: id("y") }, { kind: "wire", from: id("y"), to: id("x") }]);
  const sets = Object.fromEntries(batch.ops.flatMap((op) => (op.kind === "set" ? [[op.nodeId, (op.fields.imported as { inputs: unknown[] }).inputs]] : [])));
  expect(sets).toEqual({ [id("y")]: [{ from: "x", slot: "text" }], [id("x")]: [{ from: "y", slot: "text", held: "This connection would create a circular path." }] });
  canvas = applyTeamPatch(canvas, {
    upsertNodes: [{ ...canvas.nodes[id("y")], linked: [id("x")], imported: { ...canvas.nodes[id("y")].imported, inputs: sets[id("y")] as never } }, { ...canvas.nodes[id("x")], imported: { ...canvas.nodes[id("x")].imported, inputs: sets[id("x")] as never } }],
    fields: { [id("y")]: ["linked", "imported"], [id("x")]: ["imported"] }, removeNodes: [], upsertAssets: [], order: null, at: 3, author: "ana",
  });
  expect(planBoardImport(canvas, board, ctx, "ana").ops).toEqual([]);
  expect(importSummary(canvas, board, { id: "brd_one", name: "B" }).wires).toEqual({ total: 3, here: 1, off: 0, left: 0, refused: 2 });
});

test("a full canvas takes only what fits; the rest is counted as not fitting, with the inputs that needed it", () => {
  const nodes: Record<string, CanvasNode> = {};
  for (let i = 0; i < PROJECT_LIMITS.nodes - 1; i++) nodes[`n${i}`] = scene(`n${i}`);
  const full = { ...emptyTeamCanvas(), nodes };
  const board = readBoardGraph({ nodes: [card("a", "note", 0, 0), card("b", "note", 0, 0), card("c", "note", 0, 0)], wires: [wire("w", "a", "b", "text")] });
  expect([...cardStates(full, board, "brd_one").values()]).toEqual(["new", "full", "full"]);
  expect(planBoardImport(full, board, context(), "ana").ops.map((op) => op.kind)).toEqual(["create"]);
  const summary = importSummary(full, board, { id: "brd_one", name: "B" });
  expect([summary.cards, summary.wires.off, summary.done]).toEqual([{ total: 3, here: 0, off: 0, left: 1, refused: 2 }, 1, false]);
});

/* ── The import, against a real workspace database ──────────────────────── */

/** A production with an old board: a cast element with a picture, a location, a shot, a prompt, an image card with a render, a Library reference, a compare card and a card of an unknown kind. */
async function seed() {
  const { db, ready } = await import("../../lib/db");
  const { createBoard, getBoard, saveBoard } = await import("../../lib/boards");
  const { createElement, addVersion } = await import("../../lib/elements");
  await ready();
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0),('prod-2','Other',0)");
  for (const [uid, kind] of [["up_face", "image"], ["up_ref", "image"]])
    await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?)", args: [uid, `${uid}.png`, "image/png", "png", 1, "a".repeat(64), `/stored/${uid}.png`, 0, kind] });
  for (const gid of ["gen_take", "gen_old"])
    await db().execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,created_at,updated_at,kind) VALUES(?,?,?,?,?,?,?,?,?)", args: [gid, "prod-1", "gemini-3-pro-image", "p", "{}", "succeeded", 0, 0, "image"] });
  const noor = await createElement({ name: "Noor", kind: "character", projectId: "prod-1", description: "The lead." }, "ana");
  await addVersion(noor.attributes[0].id, { uploadId: "up_face" }, { makeCurrent: true, label: "v1" }, "ana");
  const harbour = await createElement({ name: "Harbour", kind: "location", projectId: "prod-1" }, "ana");
  const board = await createBoard("prod-1", "SH04 board");
  const nodes: BoardNode[] = [
    card("nd_noor", "asset", 40, 60, { label: "@Noor", ref: { elementId: noor.id }, settings: { kind: "character", locked: false } }),
    card("nd_harbour", "asset", 40, 400, { label: "@Harbour", ref: { elementId: harbour.id }, settings: { kind: "location" } }),
    card("nd_shot", "shot", 360, 120, { label: "SH04", ref: { shotId: "shot_x" }, settings: { title: "Noor at the harbour wall" } }),
    card("nd_prompt", "prompt", 360, 520, { text: "Wind in her hair." }),
    card("nd_image", "image", 720, 120, { label: "Nano Banana Pro", ref: { engine: "gemini-3-pro-image" }, output: { genId: "gen_take", url: "/api/media/gen_take", kind: "image", label: "SH04 v1", filedTo: { shotId: "shot_x", version: 1 } } }),
    card("nd_old", "image", 720, 520, { label: "Nano Banana Pro", ref: { engine: "gemini-3-pro-image" }, output: { genId: "gen_old", url: "/api/media/gen_old", kind: "image" } }),
    card("nd_ref", "note", 40, 760, { label: "Rain.webp", text: "REF · Rain.webp", output: { url: "/api/uploads/up_ref", kind: "image" } }),
    card("nd_compare", "compare", 1080, 120),
    card("nd_future", "hologram", 1080, 520, { label: "Hologram" }),
  ];
  const wires: BoardWire[] = [
    wire("w_cast", "nd_noor", "nd_shot", "character"),
    wire("w_place", "nd_harbour", "nd_shot", "background"),
    wire("w_prompt", "nd_prompt", "nd_image", "refs"),
    wire("w_spec", "nd_shot", "nd_image", "spec"),
    wire("w_a", "nd_image", "nd_compare", "a"),
    wire("w_b", "nd_old", "nd_compare", "b"),
    wire("w_filed", "nd_image", "nd_shot", "takes", "filed"),
  ];
  await saveBoard(board.id, { nodes, wires });
  /* A render deleted after the board was saved: its card comes across without a picture that would break a save. */
  await db().execute("UPDATE generations SET deleted=1 WHERE id='gen_old'");
  return { board: (await getBoard(board.id))!, noor, harbour };
}

test("the whole import: every card, kind, input and place arrives through applyCanvasOps; the old board is untouched and records it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { getBoard } = await import("../../lib/boards");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { latestServerChange } = await import("../../lib/workbench/canvas-ops-log");
  await runInTenant(workspace("import-whole"), async () => {
    const { board, noor, harbour } = await seed();
    const raw = async () => (await db().execute({ sql: "SELECT name,nodes,wires,updated_at FROM boards WHERE id=?", args: [board.id] })).rows[0];
    const untouched = await raw();
    expect(board.importedAt ?? null).toBeNull();

    const answer = await importBoardBatch("prod-1", board.id, "ana", { room: null });
    expect(answer).toMatchObject({
      board: { id: board.id, name: "SH04 board" }, done: true, filed: 1, live: "off", credits: 0,
      cards: { total: 9, here: 9, off: 0, left: 0, refused: 0 }, wires: { total: 6, here: 6, off: 0, left: 0, refused: 0 }, brought: { cards: 9, wires: 6 },
    });
    const canvas = (await readTeamCanvas("prod-1"))!.canvas;
    const at = (old: string) => canvas.nodes[importedNodeId(board.id, old)];
    /* Kinds and element links. */
    expect(at("nd_noor")).toMatchObject({ type: "character", refKind: "cast", elementId: noor.id, assetId: "up_face" });
    expect(at("nd_harbour")).toMatchObject({ type: "element", refKind: "environment", elementId: harbour.id });
    expect(at("nd_harbour").assetId).toBeUndefined();
    expect(at("nd_shot")).toMatchObject({ type: "scene", title: "SH04 — Noor at the harbour wall" });
    expect(at("nd_prompt")).toMatchObject({ type: "note", text: "Wind in her hair." });
    expect(at("nd_image")).toMatchObject({ type: "generate", mode: "Image", engine: "gemini-3-pro-image", assetId: "gen_take" });
    expect(at("nd_old").assetId).toBeUndefined();
    expect(at("nd_ref")).toMatchObject({ type: "media", refKind: "ref", assetId: "up_ref" });
    expect(at("nd_compare")).toMatchObject({ type: "review", verify: {} });
    expect(at("nd_future")).toMatchObject({ type: "media", refKind: "ref", text: "A “hologram” card from the old board." });
    /* Inputs, as links on their targets; the filing line is not one. Places carry over (the canvas was empty). */
    expect(at("nd_shot").linked.sort()).toEqual([importedNodeId(board.id, "nd_noor"), importedNodeId(board.id, "nd_harbour")].sort());
    expect(at("nd_image").linked.sort()).toEqual([importedNodeId(board.id, "nd_prompt"), importedNodeId(board.id, "nd_shot")].sort());
    expect(at("nd_compare").linked.sort()).toEqual([importedNodeId(board.id, "nd_image"), importedNodeId(board.id, "nd_old")].sort());
    expect(at("nd_shot").imported!.inputs).toEqual([{ from: "nd_noor", slot: "character" }, { from: "nd_harbour", slot: "background" }]);
    expect(Object.values(canvas.nodes).map((n) => [n.imported!.node, n.x, n.y]).sort()).toEqual(board.nodes.map((n) => [n.id, n.x, n.y]).sort());
    expect(Object.keys(canvas.assets).sort()).toEqual(["gen_take", "up_face", "up_ref"]);
    /* Made by the server for everyone: marked so, logged as an import, the newest change open windows fold in. */
    expect(Object.keys(canvas.serverMade).length).toBe(9);
    expect(await latestServerChange("prod-1")).toMatchObject({ what: "import", agent: false });
    const ops = (await db().execute("SELECT what,author,push FROM rig_canvas_ops")).rows.map((r) => [r.what, r.author, r.push]);
    expect(ops).toEqual([["import", "ana", "none"]]);
    /* The old board: the same name, nodes, wires and revision; only its record of the import is new. */
    expect(await raw()).toEqual(untouched);
    expect(await getBoard(board.id)).toMatchObject({ importedTo: "prod-1" });
    expect((await getBoard(board.id))!.importedAt).toBeGreaterThan(0);
    /* A person's draft folds the canvas in and still saves: every picture it now holds exists. */
    const { saveDraft } = await import("../../lib/workbench/records");
    const { newProject } = await import("../../lib/workbench/studio");
    const draft = withTeamCanvas({ ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1" }, { nodes: canvas.nodes, assets: canvas.assets, order: canvas.order });
    await expect(saveDraft("ana", draft, 0)).resolves.toMatchObject({ revision: 1, productionProjectId: "prod-1" });
  });
});

test("importing again changes nothing: no batch, no new record, the same canvas", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("import-twice"), async () => {
    const { board } = await seed();
    await importBoardBatch("prod-1", board.id, "ana", { room: null });
    const first = (await readTeamCanvas("prod-1"))!;
    const logged = Number((await db().execute("SELECT COUNT(*) AS n FROM rig_canvas_ops")).rows[0].n);
    const again = await importBoardBatch("prod-1", board.id, "bo", { room: null });
    expect(again).toMatchObject({ done: true, brought: { cards: 0, wires: 0 }, cards: { here: 9, left: 0 }, wires: { here: 6, left: 0 } });
    const second = (await readTeamCanvas("prod-1"))!;
    expect(second.revision).toBe(first.revision);
    expect(second.canvas).toEqual(first.canvas);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM rig_canvas_ops")).rows[0].n)).toBe(logged);
  });
});

test("importing after the old board changed brings only what is new; a card a person took off stays off, an input they unwired stays unwired, their edits stand", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { getBoard, saveBoard } = await import("../../lib/boards");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  const { patchTeamCanvas, readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("import-delta"), async () => {
    const { board } = await seed();
    await importBoardBatch("prod-1", board.id, "ana", { room: null });
    let canvas = (await readTeamCanvas("prod-1"))!.canvas;
    const B = (old: string) => importedNodeId(board.id, old);
    /* On the new Rig: Bo takes the unknown card off, unwires the harbour from the shot, and rewrites the prompt. */
    await patchTeamCanvas("prod-1", {
      upsertNodes: [{ ...canvas.nodes[B("nd_shot")], linked: [B("nd_noor")] }, { ...canvas.nodes[B("nd_prompt")], text: "Bo's prompt" }],
      fields: { [B("nd_shot")]: ["linked"], [B("nd_prompt")]: ["text"] }, removeNodes: [B("nd_future")], upsertAssets: [], order: null,
    }, "bo");
    /* On the old board: a new note wired into the shot, a new input from the harbour into the image, and the old prompt reworded.
       (Its page saves only boards whose renders all exist: the one deleted after the first import is back in the Library.) */
    const { db } = await import("../../lib/db");
    await db().execute("UPDATE generations SET deleted=0 WHERE id='gen_old'");
    const current = (await getBoard(board.id))!;
    await saveBoard(board.id, {
      nodes: [...current.nodes.map((n) => (n.id === "nd_prompt" ? { ...n, text: "Old board's new words" } : n)), card("nd_new", "note", 360, 760, { label: "Note", text: "Golden hour." })],
      wires: [...current.wires, wire("w_new", "nd_new", "nd_shot", "prompt"), wire("w_place2", "nd_harbour", "nd_image", "refs")],
    });
    const answer = await importBoardBatch("prod-1", board.id, "ana", { room: null });
    expect(answer).toMatchObject({ done: true, brought: { cards: 1, wires: 2 }, cards: { total: 10, here: 9, off: 1, left: 0 }, wires: { total: 8, here: 8, off: 0, left: 0 } });
    canvas = (await readTeamCanvas("prod-1"))!.canvas;
    expect(canvas.nodes[B("nd_future")]).toBeUndefined();
    expect(canvas.removed[B("nd_future")]).toBeTruthy();
    expect(canvas.nodes[B("nd_new")]).toMatchObject({ type: "note", text: "Golden hour." });
    /* The shot takes the new note, and never the harbour Bo unwired. */
    expect(canvas.nodes[B("nd_shot")].linked).toEqual([B("nd_noor"), B("nd_new")]);
    expect(canvas.nodes[B("nd_image")].linked).toContain(B("nd_harbour"));
    expect(canvas.nodes[B("nd_prompt")].text).toBe("Bo's prompt");
    /* Nothing twice. */
    expect(Object.keys(canvas.nodes).filter((k) => k === B("nd_new"))).toHaveLength(1);
    expect(new Set(canvas.nodes[B("nd_shot")].linked).size).toBe(canvas.nodes[B("nd_shot")].linked.length);
  });
});

test("batches are bounded and resumable: a stopped import carries on where it stopped and ends where one long run would; the same batch twice is applied once", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const { applyCanvasOps } = await import("../../lib/workbench/canvas-ops");
  const small = { cards: 2, wires: 2 };
  let whole: TeamCanvas | null = null;
  await runInTenant(workspace("import-one-go"), async () => {
    const { board } = await seed();
    await importBoardBatch("prod-1", board.id, "ana", { room: null });
    whole = (await readTeamCanvas("prod-1"))!.canvas;
  });
  await runInTenant(workspace("import-batches"), async () => {
    const { board } = await seed();
    const seen: { cards: number; wires: number }[] = [];
    let answer = await importBoardBatch("prod-1", board.id, "ana", { room: null, limits: small });
    seen.push(answer.brought);
    /* Stopped here (a closed tab): the next call, from anyone, carries on. */
    for (let i = 0; i < 20 && !answer.done; i++) {
      answer = await importBoardBatch("prod-1", board.id, i % 2 ? "bo" : "ana", { room: null, limits: small });
      seen.push(answer.brought);
    }
    expect(answer.done).toBe(true);
    expect(seen.every((b) => b.cards <= 2 && b.wires <= 2)).toBe(true);
    expect(seen.reduce((sum, b) => sum + b.cards, 0)).toBe(9);
    expect(seen.reduce((sum, b) => sum + b.wires, 0)).toBe(6);
    expect(Number((await db().execute("SELECT COUNT(*) AS n FROM rig_canvas_ops WHERE what='import'")).rows[0].n)).toBeGreaterThan(3);
    const canvas = (await readTeamCanvas("prod-1"))!.canvas;
    /* The same cards, places, links and records as one long run (board ids differ per workspace: compare by old card). */
    const shape = (c: TeamCanvas) => Object.values(c.nodes)
      .map((n) => ({ node: n.imported!.node, type: n.type, title: n.title, text: n.text, x: n.x, y: n.y, refKind: n.refKind, assetId: n.assetId,
        linked: n.linked.map((l) => c.nodes[l]?.imported?.node).sort(), inputs: [...(n.imported!.inputs ?? [])].sort((a, b) => a.from.localeCompare(b.from)) }))
      .sort((a, b) => String(a.node).localeCompare(String(b.node)));
    expect(shape(canvas)).toEqual(shape(whole!));
    /* A batch that arrives twice (a lost reply) is applied once and answers the same. */
    const row = (await db().execute("SELECT op_id,ops FROM rig_canvas_ops WHERE what='import' ORDER BY seq LIMIT 1")).rows[0];
    const replay = await applyCanvasOps("prod-1", { opId: String(row.op_id), ops: JSON.parse(String(row.ops)), author: "ana", what: "import" }, { room: null });
    expect(replay.replay).toBe(true);
    expect((await readTeamCanvas("prod-1"))!.canvas).toEqual(canvas);
  });
});

test("only a board of this production comes across, and only one that is in this workspace", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { importBoardBatch } = await import("../../lib/workbench/board-import");
  const { readTeamCanvas } = await import("../../lib/workbench/team-canvas");
  await runInTenant(workspace("import-refused"), async () => {
    const { board } = await seed();
    await expect(importBoardBatch("prod-2", board.id, "ana", { room: null })).rejects.toMatchObject({ status: 409 });
    await expect(importBoardBatch("prod-1", "brd_missing", "ana", { room: null })).rejects.toMatchObject({ status: 404 });
    await expect(importBoardBatch("prod-x", board.id, "ana", { room: null })).rejects.toMatchObject({ status: 404 });
    expect(await readTeamCanvas("prod-2")).toBeNull();
  });
});

/* ── What the old board links to, and what the new Rig says ─────────────── */

test("the link: this person's own draft of the production, or the production opened as their new draft; the import param is read strictly", async () => {
  expect(newRigHref("draft-1", "brd_1")).toBe("/suites?project=draft-1&page=rig&import=brd_1");
  expect(importParam("?project=d&import=brd_1")).toBe("brd_1");
  expect([importParam("?import=a&import=b"), importParam("?import=../x"), importParam("?project=d")]).toEqual([null, null, null]);
  expect(withoutImport("/suites?project=d&page=rig&import=brd_1&view=gen")).toBe("/suites?project=d&page=rig&view=gen");
  expect(withoutImport("/suites?project=d")).toBeNull();

  const calls: string[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const own = await newRigFor({ production: "prod-1", boardId: "brd_1", scope: "s", fetch: async (url, init) => { calls.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string>)["X-Workbench-Scope"]}`); return reply(200, { id: "draft-mine" }); } });
  expect(own).toBe("/suites?project=draft-mine&page=rig&import=brd_1");
  expect(calls).toEqual(["GET /api/workbench/projects?production=prod-1 s"]);

  calls.length = 0;
  const opened = await newRigFor({ production: "prod-1", boardId: "brd_1", scope: "s", fetch: async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!init?.method) return reply(200, { id: null });
    if (init.method === "POST") return reply(200, { project: { id: "draft-new", productionProjectId: "prod-1" } });
    expect(JSON.parse(String(init.body))).toEqual({ project: { id: "draft-new", productionProjectId: "prod-1" }, revision: 0 });
    return reply(200, { revision: 1 });
  } });
  expect(opened).toBe("/suites?project=draft-new&page=rig&import=brd_1");
  expect(calls).toEqual(["GET /api/workbench/projects?production=prod-1", "POST /api/workbench/projects", "PUT /api/workbench/projects"]);
  await expect(newRigFor({ production: "prod-1", boardId: "brd_1", scope: "s", fetch: async () => reply(500, {}) })).rejects.toThrow("The new Rig could not be opened. Try again.");
  await expect(newRigFor({ production: "prod-1", boardId: "brd_1", scope: "s", fetch: async (_url, init) => (init?.method ? reply(404, { error: "Project not found" }) : reply(200, { id: null })) })).rejects.toThrow("not in this workspace");
});

test("what the Rig says: while it runs, when it is done (or had nothing new), and when it stopped part way, with Try again", () => {
  const summary = (cards: Partial<ImportCounts>, wires: Partial<ImportCounts> = {}, filed = 0) => ({
    board: { id: "brd_1", name: "SH04 board" }, cards: { total: 9, here: 9, off: 0, left: 0, refused: 0, ...cards }, wires: { total: 6, here: 6, off: 0, left: 0, refused: 0, ...wires }, filed, done: true,
  });
  expect(importCopy({ phase: "waiting" }).line).toBe("Bringing an old board across…");
  expect(importCopy({ phase: "running", answer: summary({ here: 4, left: 5 }), brought: { cards: 4, wires: 0 } })).toEqual({ line: "Bringing “SH04 board” across · 4 of 9 cards", notes: ["Free. The old board stays as it was."] });
  expect(importCopy({ phase: "done", answer: summary({}, {}, 1), brought: { cards: 9, wires: 6 } })).toEqual({
    line: "“SH04 board” is on the new Rig: 9 cards and 6 connections.",
    notes: ["Filing lines stay on the old board; their takes are in Takes.", "Free. The old board stays as it was."],
  });
  expect(importCopy({ phase: "done", answer: summary({ here: 8, off: 1 }, { here: 5, refused: 1 }), brought: { cards: 0, wires: 0 } })).toEqual({
    line: "Everything on “SH04 board” is already on the new Rig. Nothing new came across.",
    notes: ["1 card someone took off the new Rig stays off.", "1 connection couldn’t be made here: a loop, or a locked card.", "Free. The old board stays as it was."],
  });
  expect(importCopy({ phase: "failed", answer: summary({ here: 4, left: 5 }, { here: 1, left: 5 }), brought: { cards: 4, wires: 1 }, error: "x", final: false })).toEqual({
    line: "Part of “SH04 board” came across: 4 of 9 cards and 1 of 6 connections. The rest didn’t reach the new Rig.",
    notes: ["Trying again is free and brings only what is missing."],
  });
  expect(importCopy({ phase: "failed", answer: null, brought: { cards: 0, wires: 0 }, error: "The old board did not reach the new Rig. Try again.", final: false }).line).toBe("The old board did not reach the new Rig. Try again.");
  expect(importCopy({ phase: "running", answer: null, brought: { cards: 0, wires: 0 } }).line).toBe("Bringing the old board across…");
  expect(importCopy({ phase: "failed", answer: null, brought: { cards: 0, wires: 0 }, error: "That board belongs to another production.", final: true })).toEqual({ line: "The old board can’t come across here. That board belongs to another production.", notes: [] });
  expect(mediaCandidates(readBoardGraph({ nodes: [card("n", "note", 0, 0, { output: { url: "/api/uploads/up_1" } }), card("i", "image", 0, 0, { output: { genId: "gen_1" } })], wires: [] }), new Map())).toEqual({ uploads: ["up_1"], generations: ["gen_1"] });
});

test("one batch from the Rig: the board's own route, this account's scope; a refusal the server would repeat is final, anything else is Try again", async () => {
  const answer = {
    board: { id: "brd_1", name: "SH04 board" }, cards: { total: 2, here: 2, off: 0, left: 0, refused: 0 }, wires: { total: 1, here: 1, off: 0, left: 0, refused: 0 },
    filed: 0, done: true, brought: { cards: 2, wires: 1 }, live: "off", credits: 0,
  };
  expect(isImportAnswer(answer)).toBe(true);
  expect([isImportAnswer(null), isImportAnswer({ ...answer, cards: { total: 2 } }), isImportAnswer({ ...answer, brought: null })]).toEqual([false, false, false]);
  expect([importedBoardOf({ imported: { board: "brd_1" } }), importedBoardOf({ imported: {} }), importedBoardOf(undefined)]).toEqual(["brd_1", null, null]);
  const real = globalThis.fetch;
  const sent: { url: string; scope: string | null; body: unknown }[] = [];
  const reply = (status: number, body: unknown) => async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), scope: new Headers(init?.headers).get("X-Workbench-Scope"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  try {
    globalThis.fetch = reply(200, answer) as typeof fetch;
    expect(await importBatch({ scope: "particl-active-ws-me", boardId: "brd_1", productionId: "prod-1" })).toEqual({ ok: true, answer });
    expect(sent).toEqual([{ url: "/api/rig/boards/brd_1", scope: "particl-active-ws-me", body: { action: "import", productionId: "prod-1" } }]);
    globalThis.fetch = reply(409, { error: "That board belongs to another production. Open that production’s Rig to bring it across." }) as typeof fetch;
    expect(await importBatch({ scope: "s", boardId: "brd_1", productionId: "prod-2" })).toEqual({ ok: false, final: true, error: "That board belongs to another production. Open that production’s Rig to bring it across." });
    globalThis.fetch = reply(503, { error: "The database is busy." }) as typeof fetch;
    expect(await importBatch({ scope: "s", boardId: "brd_1", productionId: "prod-1" })).toEqual({ ok: false, final: false, error: IMPORT_FAILED });
    globalThis.fetch = reply(200, { board: "not an answer" }) as typeof fetch;
    expect(await importBatch({ scope: "s", boardId: "brd_1", productionId: "prod-1" })).toEqual({ ok: false, final: false, error: IMPORT_FAILED });
  } finally {
    globalThis.fetch = real;
  }
});
