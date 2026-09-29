import type { BoardNode, BoardWire } from "../boards";
import { ENVIRONMENT_CATEGORY } from "../production/environment";
import { cardWidth } from "../workspace/rig-graph";
import { planCanvasOps, type CanvasOp } from "./canvas-ops-model";
import { nodeDef } from "./node-graph";
import { PROJECT_LIMITS } from "./project-limits";
import { stableId } from "./stable-id";
import { IMPORTED_INPUTS, IMPORTED_NODE_FIELD_CHARS } from "./studio-schema";
import type { Asset, CanvasNode, ImportedInput, NodeImported, NodeType, RefKind } from "./studio";
import type { TeamCanvas } from "./team-canvas-model";

/*
 * Opening an old Rig board (lib/boards.ts: a `boards` row, its nodes and wires
 * as JSON) in the new Rig, the production's team canvas. The pure half: which
 * card each old card becomes, where it goes, what is still to come, and one
 * bounded batch of canvas operations at a time. lib/workbench/board-import.ts
 * reads the board and applies each batch through applyCanvasOps, so every open
 * window sees the cards arrive.
 *
 *  - One way, additive: the old board is only read. Its cards come across as
 *    copies; nothing on the board changes.
 *  - Stable ids (stableId("node", "board", boardId, nodeId)): a card already on
 *    the canvas is never made twice, and one someone took off stays off, so
 *    importing again brings only what is new on the old board.
 *  - An old wire becomes a link on its target (links are per card here). Each
 *    imported card keeps the old inputs the import handled (`imported.inputs`),
 *    with the slot each landed on, so an input a person unwired on the new Rig
 *    is never brought back, and one the new Rig's rules refuse (a loop) is
 *    noted on the card rather than lost. Filing lines (a take filed to its
 *    shot) are records, not inputs, and stay on the old board.
 *  - Resumable: every batch is planned from the canvas as it is, so an import
 *    that stopped anywhere carries on where it stopped. Free.
 */

/** A card's record of the old board it came from (CanvasNode.imported), when it has one. */
export const importedOf = (node: CanvasNode | undefined): NodeImported | undefined => node?.imported;

/** The old board's card kinds, as lib/boards.ts names them, and the word each is shown as. */
export const BOARD_KIND_WORDS: Record<string, string> = {
  asset: "Asset", shot: "Shot", prompt: "Prompt", image: "Image", video: "Video", edit: "Edit",
  upscale: "Upscale", audio: "Audio", voice: "Voice", compare: "Compare", note: "Note",
};

/** The card an old card becomes on the new Rig: its node type and, for a reference, its kind. */
export type ImportedShape = { type: NodeType; refKind?: RefKind; mode?: string; verify?: true };

/**
 * Which new-Rig card an old card becomes. `element` is the kind of the element
 * an asset card stands for (lib/rig.ts: character, location, prop, look,
 * voice); `picture`, whether a note carries a picture (a Library reference).
 *
 *  - asset → a reference with its kind: a character is Cast, a location an
 *    Environment, a prop an Element; a look is a Look board (its own kind, as
 *    on the old board); a voice is a Ref;
 *  - shot → a scene; image and video → generate cards (shots here too);
 *  - prompt and note → direction notes; a note carrying a picture → a Ref;
 *  - compare → a review card with an empty `verify` (the Verify step's card);
 *  - edit, upscale, audio and voice could not run on a board: each is a Ref
 *    that says what it was (with any render it holds all the same), as is a
 *    kind this release does not know.
 */
export function importedShape(kind: string, element?: string | null, picture = false): ImportedShape {
  switch (kind) {
    case "asset":
      switch (element) {
        case "character": return { type: "character", refKind: "cast" };
        case "location": return { type: "element", refKind: "environment" };
        case "look": return { type: "moodboard" };
        case "voice": return { type: "media", refKind: "ref" };
        default: return { type: "element", refKind: "element" };
      }
    case "shot": return { type: "scene", mode: "Video" };
    case "prompt": return { type: "note" };
    case "note": return picture ? { type: "media", refKind: "ref" } : { type: "note" };
    case "image": return { type: "generate", mode: "Image" };
    case "video": return { type: "generate", mode: "Video" };
    case "compare": return { type: "review", verify: true };
    default: return { type: "media", refKind: "ref" };
  }
}

/** The id an old card has on the new Rig: the same every time, so importing again finds it. */
export const importedNodeId = (boardId: string, nodeId: string) => stableId("node", "board", boardId, nodeId);

/** A stored original an imported card shows: an upload or a generation, by id. */
export type MediaRef = { source: "upload" | "generation"; id: string };
const mediaKey = (ref: MediaRef) => `${ref.source}:${ref.id}`;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The upload or generation a stored-media URL names (`/api/uploads/<id>`, `/api/media/<id>`), else null. */
export function mediaOfUrl(url: unknown): MediaRef | null {
  if (typeof url !== "string") return null;
  const match = url.match(/^\/api\/(uploads|media)\/([^/?#]+)(?:[?#].*)?$/);
  if (!match) return null;
  let id: string;
  try { id = decodeURIComponent(match[2]); } catch { return null; }
  return MEDIA_ID.test(id) ? { source: match[1] === "uploads" ? "upload" : "generation", id } : null;
}

/** What the import knows about an element an asset card stands for. */
export type ImportElement = { kind: string; name: string; description: string; picture: MediaRef | null };

export type ImportContext = {
  boardId: string;
  boardName: string;
  /** The elements the board's asset cards cite, by id; one that is gone is simply absent. */
  elements: Map<string, ImportElement>;
  /** Stored media that exists and may be shown (an upload, or a generation that succeeded and was not deleted), by `upload:<id>` or `generation:<id>`, with its kind. */
  media: Map<string, Asset["kind"]>;
  /** The workspace's default engines, for an image or video card that named none (the old board rendered with them). */
  models?: { image?: string; video?: string };
};

/** One old input into a card, as the new Rig links it: per pair of cards, with the old slots it landed on. */
export type WirePair = { from: string; to: string; slots: string[] };

/** An old board read defensively: its cards once each, in board order, and its inputs as pairs. */
export type BoardGraph = { nodes: BoardNode[]; pairs: WirePair[]; filed: number };

const NODE_ID_MAX = 200;
const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function readBoardGraph(board: { nodes: unknown; wires: unknown }): BoardGraph {
  const nodes: BoardNode[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(board.nodes) ? board.nodes : []) {
    const node = raw as BoardNode | null;
    if (!node || typeof node !== "object" || typeof node.id !== "string" || !node.id || node.id.length > NODE_ID_MAX || ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node);
  }
  const pairs = new Map<string, WirePair>();
  let filed = 0;
  for (const raw of Array.isArray(board.wires) ? board.wires : []) {
    const wire = raw as BoardWire | null;
    const from = wire?.from?.nodeId, to = wire?.to?.nodeId;
    if (typeof from !== "string" || typeof to !== "string" || from === to || !ids.has(from) || !ids.has(to)) continue;
    const slot = clip(wire!.to.slotId, 40);
    /* A take filed to its shot: a record of where a render went, not an input into anything. */
    if (wire!.kind === "filed" || wire!.kind === "created" || slot === "takes") { filed++; continue; }
    const key = JSON.stringify([from, to]);
    const pair = pairs.get(key) ?? { from, to, slots: [] };
    if (slot && !pair.slots.includes(slot)) pair.slots.push(slot);
    pairs.set(key, pair);
  }
  return { nodes, pairs: [...pairs.values()], filed };
}

/** Where the board sits on this canvas: its old positions, moved by (dx, dy). */
export type Placement = { dx: number; dy: number };
/** How far to the right of the cards already on the canvas an imported board starts. */
export const PLACE_GAP = 160;
const MIN = -10_000, MAX = 20_000;
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const place = (value: unknown, by: number) => Math.min(MAX, Math.max(MIN, Math.round(finite(value) + by)));

/**
 * Where the board goes. Its first import fixes it and every card it brings
 * keeps it (`imported.dx`, `dy`), so cards brought later land beside the ones
 * brought before. On an empty canvas the old positions carry over as they are;
 * on one that already holds cards, the board starts to their right.
 */
export function boardPlacement(canvas: Pick<TeamCanvas, "nodes" | "removed">, boardId: string, nodes: readonly BoardNode[]): Placement {
  for (const node of [...Object.values(canvas.nodes), ...Object.values(canvas.removed)]) {
    const from = importedOf(node);
    if (from?.board === boardId && typeof from.dx === "number" && Number.isFinite(from.dx) && typeof from.dy === "number" && Number.isFinite(from.dy)) return { dx: from.dx, dy: from.dy };
  }
  const others = Object.values(canvas.nodes).filter((node) => importedOf(node)?.board !== boardId);
  if (!others.length || !nodes.length) return { dx: 0, dy: 0 };
  const right = Math.max(...others.map((node) => finite(node.x) + cardWidth(node)));
  const top = Math.min(...others.map((node) => finite(node.y)));
  return { dx: Math.round(right + PLACE_GAP - Math.min(...nodes.map((n) => finite(n.x)))), dy: Math.round(top - Math.min(...nodes.map((n) => finite(n.y)))) };
}

const ELEMENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const ENGINE = /^[A-Za-z0-9._/:-]{1,200}$/;
const RATIO = /^(?:adaptive|auto|\d{1,2}(?:\.\d{1,2})?:\d{1,2})$/;
const RESOLUTION = /^[0-9A-Za-z]{1,12}$/;
const TEXT_MAX = 20_000;
const engineOf = (value: unknown) => (typeof value === "string" && ENGINE.test(value) ? value : undefined);
const CATEGORY: Record<string, string> = { character: "Character", location: ENVIRONMENT_CATEGORY, prop: "Element", look: "Look", voice: "Voice" };
const widthFor = (type: NodeType) => { const shape = nodeDef(type).shape; return shape === "scene" ? 344 : shape === "reference" || shape === "text" ? 280 : 236; };

/**
 * One old card as the new Rig card it becomes, with the stored picture it
 * shows when it has one that still exists (an element's current picture, a
 * render, a Library reference). It starts with no inputs: its old inputs are
 * wired by the new Rig's own rules (planBoardImport).
 */
export function mapBoardNode(old: BoardNode, ctx: ImportContext, at: Placement, extra: { look?: string } = {}): { node: CanvasNode; asset: Asset | null } {
  const kind = typeof old.kind === "string" ? old.kind.slice(0, 40) : "";
  const word = BOARD_KIND_WORDS[kind] ?? null;
  const label = clip(old.label, 200);
  const settings = (old.settings && typeof old.settings === "object" ? old.settings : {}) as Record<string, unknown>;
  const ref = (old.ref && typeof old.ref === "object" ? old.ref : {}) as Record<string, unknown>;
  const output = (old.output && typeof old.output === "object" ? old.output : {}) as Record<string, unknown>;
  const elementId = kind === "asset" && typeof ref.elementId === "string" && ELEMENT_ID.test(ref.elementId) ? ref.elementId : undefined;
  const element = elementId ? ctx.elements.get(elementId) : undefined;
  const elementKind = kind === "asset" ? clip(element?.kind ?? settings.kind, 40) || undefined : undefined;
  const shown = (media: MediaRef | null | undefined) => (media && ctx.media.has(mediaKey(media)) ? media : null);
  const notePicture = kind === "note" ? shown(mediaOfUrl(output.url)) : null;
  const shape = importedShape(kind, elementKind, !!notePicture);
  const id = importedNodeId(ctx.boardId, old.id);
  const said = clip(old.text, TEXT_MAX);
  /* A render the card made (any card that renders, even one that never could on a board): it comes across as the card's take. */
  const gen = typeof output.genId === "string" && MEDIA_ID.test(output.genId) ? output.genId : "";
  const take = kind !== "asset" && kind !== "note" && kind !== "prompt" && kind !== "shot" ? shown(gen ? { source: "generation", id: gen } : null) : null;
  const ran = take ? "" : " It never ran there.";

  let title: string, text = "";
  switch (kind) {
    case "asset": title = label || (element ? `@${element.name}` : "Asset"); text = clip(element?.description, TEXT_MAX); break;
    case "shot": { const what = clip(settings.title, TEXT_MAX); title = what ? `${label || "Shot"} — ${what}` : label || "Shot"; text = what; break; }
    case "prompt": title = "Prompt"; text = said; break;
    case "note": title = label || "Note"; text = said; break;
    case "image": title = label && label !== word ? `Image · ${label}` : "Image"; text = clip(settings.prompt, TEXT_MAX); break;
    case "video": {
      title = label && label !== word ? `Video · ${label}` : "Video";
      const motion = clip(settings.motion, 2000);
      text = [clip(settings.prompt, TEXT_MAX), motion ? `Motion: ${motion}` : ""].filter(Boolean).join("\n");
      break;
    }
    case "compare": title = label || "Compare"; text = said || `Compare card from the old board (A and B).${ran}`; break;
    default:
      if (word) { title = label && label !== word ? `${word} · ${label}` : word; text = [`${word} card from the old board.${ran}`, said].filter(Boolean).join("\n"); }
      else { title = label || "Card"; text = [kind ? `A “${kind}” card from the old board.` : "A card from the old board, of a kind this release does not know.", said].filter(Boolean).join("\n"); }
  }

  /* The picture it shows: an element's current one, the render a card made, or a Library reference on a note. */
  let picture: MediaRef | null = null, category = "Reference", takeOf: string | undefined;
  if (kind === "asset") { picture = shown(element?.picture); category = CATEGORY[elementKind ?? ""] ?? "Element"; }
  else if (take) { picture = take; category = "Shot"; takeOf = id; }
  else if (notePicture) picture = notePicture;
  const filed = output.filedTo && typeof output.filedTo === "object" ? Number((output.filedTo as Record<string, unknown>).version) : NaN;
  const asset: Asset | null = picture ? {
    id: picture.id, name: clip(output.label, 200) || title.slice(0, 200) || "Reference", kind: ctx.media.get(mediaKey(picture))!, category,
    url: picture.source === "upload" ? `/api/uploads/${encodeURIComponent(picture.id)}` : `/api/media/${encodeURIComponent(picture.id)}`,
    description: `From the old board “${ctx.boardName.slice(0, 200)}”`, prompt: "", status: "Draft", locked: false,
    version: Number.isInteger(filed) && filed > 0 ? filed : 1, refs: [],
    ...(picture.source === "upload" ? { uploadId: picture.id } : { generationId: picture.id }),
    ...(takeOf ? { nodeId: takeOf } : {}),
  } : null;

  const shot = kind === "shot" && typeof ref.shotId === "string" && ELEMENT_ID.test(ref.shotId) ? ref.shotId : undefined;
  const imported: NodeImported = {
    board: ctx.boardId, node: old.id, kind: kind || "unknown", ...(elementKind ? { element: elementKind } : {}), ...(shot ? { shot } : {}),
    dx: at.dx, dy: at.dy, inputs: [],
  };
  const node: CanvasNode = {
    id, type: shape.type, title: title.slice(0, 300), x: place(old.x, at.dx), y: place(old.y, at.dy), width: widthFor(shape.type), linked: [],
    role: nodeDef(shape.type).role, status: "draft",
    ...(text ? { text: text.slice(0, TEXT_MAX) } : {}),
    ...(shape.refKind ? { refKind: shape.refKind } : {}),
    ...(elementId ? { elementId } : {}),
    ...(shape.mode ? { mode: shape.mode } : {}),
    ...(shape.verify ? { verify: {} } : {}),
    ...(asset ? { assetId: asset.id } : {}),
    ...(shape.type === "generate" ? shotSettings(kind, settings, ref, ctx) : {}),
    ...(extra.look && shape.type === "scene" ? { look: extra.look } : {}),
    imported,
  };
  return { node, asset };
}

/** The render settings an image or video card had, where the new Rig can hold them; the workspace's default engine when it named none. */
function shotSettings(kind: string, settings: Record<string, unknown>, ref: Record<string, unknown>, ctx: ImportContext): Partial<CanvasNode> {
  const engine = engineOf(ref.engine) ?? engineOf(kind === "image" ? ctx.models?.image : ctx.models?.video);
  const seconds = Math.round(finite(settings.seconds));
  return {
    ...(engine ? { engine } : {}),
    ...(kind === "video" && seconds >= 1 && seconds <= 60 ? { durationS: seconds } : {}),
    ...(typeof settings.ratio === "string" && RATIO.test(settings.ratio) ? { ratio: settings.ratio } : {}),
    ...(typeof settings.resolution === "string" && RESOLUTION.test(settings.resolution) ? { resolution: settings.resolution } : {}),
  };
}

/** The stored media a board's cards could show: element pictures, renders and Library references (the server checks each exists). */
export function mediaCandidates(graph: BoardGraph, elements: Map<string, ImportElement>): { uploads: string[]; generations: string[] } {
  const uploads = new Set<string>(), generations = new Set<string>();
  const add = (ref: MediaRef | null | undefined) => { if (ref && MEDIA_ID.test(ref.id)) (ref.source === "upload" ? uploads : generations).add(ref.id); };
  for (const node of graph.nodes) {
    const ref = (node.ref && typeof node.ref === "object" ? node.ref : {}) as Record<string, unknown>;
    const output = (node.output && typeof node.output === "object" ? node.output : {}) as Record<string, unknown>;
    if (node.kind === "asset" && typeof ref.elementId === "string") add(elements.get(ref.elementId)?.picture);
    if (!["asset", "note", "prompt", "shot"].includes(String(node.kind)) && typeof output.genId === "string") add({ source: "generation", id: output.genId });
    if (node.kind === "note") add(mediaOfUrl(output.url));
  }
  return { uploads: [...uploads], generations: [...generations] };
}

/* ── What is on the canvas already, and what is still to come ─────────────── */

/** here: on the canvas · off: someone took it off (it stays off) · new: still to come · full: the canvas has no room for it. */
export type CardState = "here" | "off" | "new" | "full";

export function cardStates(canvas: Pick<TeamCanvas, "nodes" | "removed">, graph: BoardGraph, boardId: string): Map<string, CardState> {
  const states = new Map<string, CardState>();
  let room = PROJECT_LIMITS.nodes - Object.keys(canvas.nodes).length;
  for (const node of graph.nodes) {
    const id = importedNodeId(boardId, node.id);
    if (canvas.nodes[id]) states.set(node.id, "here");
    else if (canvas.removed[id]) states.set(node.id, "off");
    else if (room > 0) { states.set(node.id, "new"); room--; }
    else states.set(node.id, "full");
  }
  return states;
}

/** Whether a card's record of handled inputs can take one more (it is bounded like any node field). */
function recordHasRoom(record: NodeImported | undefined, entry: ImportedInput): boolean {
  const inputs = record?.inputs ?? [];
  return inputs.length < IMPORTED_INPUTS && JSON.stringify({ ...record, inputs: [...inputs, entry] }).length <= IMPORTED_NODE_FIELD_CHARS;
}

/**
 * here: linked (or handled before: an input a person since unwired stays unwired) · held: the new Rig's rules refuse it
 * (it is noted on the card) · off: a card at either end was taken off, or has no room · locked: its card is locked, so
 * it waits · waiting: a card at either end is still to come · new: to be linked.
 */
export type PairState = "here" | "held" | "off" | "locked" | "waiting" | "new";

export function pairState(canvas: Pick<TeamCanvas, "nodes">, boardId: string, pair: WirePair, cards: Map<string, CardState>): PairState {
  const from = cards.get(pair.from), to = cards.get(pair.to);
  if (from === "off" || to === "off" || from === "full" || to === "full") return "off";
  const target = canvas.nodes[importedNodeId(boardId, pair.to)];
  const handled = importedOf(target)?.inputs?.find((input) => input?.from === pair.from);
  if (handled) return handled.held ? "held" : "here";
  if (from === "new" || to === "new" || !target) return "waiting";
  if (target.locked) return "locked";
  if (!recordHasRoom(importedOf(target), { from: pair.from, slot: pair.slots.join(", ") })) return "held";
  return "new";
}

export type ImportCounts = { total: number; here: number; off: number; left: number; refused: number };
export type ImportSummary = {
  board: { id: string; name: string };
  /** The old board's cards: on the new Rig, taken off it by someone (they stay off), still to come, and without room. */
  cards: ImportCounts;
  /** Its inputs, as the new Rig links them (one per pair of cards): linked, with a card that is off, still to come, and refused by the new Rig's rules (a loop, a locked card). */
  wires: ImportCounts;
  /** Filing lines (a take filed to its shot): records, not inputs, so they stay on the old board. */
  filed: number;
  /** Nothing is left to bring across. */
  done: boolean;
};

export function importSummary(canvas: Pick<TeamCanvas, "nodes" | "removed">, graph: BoardGraph, board: { id: string; name: string }): ImportSummary {
  const cards = cardStates(canvas, graph, board.id);
  const cardCount = (state: CardState) => [...cards.values()].filter((value) => value === state).length;
  const pairs = graph.pairs.map((pair) => pairState(canvas, board.id, pair, cards));
  const pairCount = (...states: PairState[]) => pairs.filter((value) => states.includes(value)).length;
  const cardsOut: ImportCounts = { total: graph.nodes.length, here: cardCount("here"), off: cardCount("off"), left: cardCount("new"), refused: cardCount("full") };
  const wiresOut: ImportCounts = { total: pairs.length, here: pairCount("here"), off: pairCount("off"), left: pairCount("new", "waiting"), refused: pairCount("held", "locked") };
  return { board: { id: board.id, name: board.name }, cards: cardsOut, wires: wiresOut, filed: graph.filed, done: cardsOut.left === 0 && wiresOut.left === 0 };
}

/** One call's answer: where the import stands, and what this call brought across. */
export type BoardImportAnswer = ImportSummary & {
  brought: { cards: number; wires: number };
  /** "sent": the live room has it; "waiting": it goes out again until it lands; "off": no live room (windows check every few seconds). */
  live: "sent" | "waiting" | "off";
  credits: 0;
};

/* ── One batch ─────────────────────────────────────────────────────────── */

/** A bounded write per request: this many cards made, and this many inputs linked, at most. */
export const IMPORT_BATCH = { cards: 100, wires: 150 } as const;
export type ImportLimits = { cards: number; wires: number };

export type ImportBatch = {
  ops: CanvasOp[];
  /** Names the batch by what it does, so the same batch sent twice (a lost reply, two windows) is applied once. Null: nothing to do. */
  opId: string | null;
  cards: number;
  wires: number;
};

/** A wire held only for now: a card at one end is not on the canvas yet, or its target is locked. Tried again next time. */
const heldForNow = (held: string) => held.startsWith("Choose two existing") || held.startsWith("Unlock this node");

/**
 * The order cards come across in: board order, with each card after the cards that feed it (a loop keeps board order).
 * A card's inputs then come across in the batch that makes it, so an import never goes back to change a card it made in
 * an earlier batch — a change an open window's draft save, folding the canvas in between batches, could write over.
 */
export function importOrder(graph: BoardGraph): BoardNode[] {
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sources = new Map<string, string[]>();
  for (const pair of graph.pairs) sources.set(pair.to, [...(sources.get(pair.to) ?? []), pair.from]);
  const feeds = (id: string) => [...(sources.get(id) ?? [])].sort((a, b) => index.get(a)! - index.get(b)!);
  const out: BoardNode[] = [];
  const placed = new Set<string>(), open = new Set<string>();
  /* Depth first, sources before the card, without recursion (a long chain is a deep one). */
  for (const root of graph.nodes) {
    if (placed.has(root.id)) continue;
    const stack = [{ id: root.id, from: feeds(root.id), next: 0 }];
    open.add(root.id);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.next < top.from.length) {
        const source = top.from[top.next++];
        if (!placed.has(source) && !open.has(source)) { open.add(source); stack.push({ id: source, from: feeds(source), next: 0 }); }
        continue;
      }
      stack.pop();
      open.delete(top.id);
      placed.add(top.id);
      out.push(byId.get(top.id)!);
    }
  }
  return out;
}

/**
 * The next batch: cards still to come, sources first (importOrder), each with
 * its inputs from cards already on the canvas or made in the same batch; then
 * inputs into cards already here (an old board that gained an input since).
 * Each input is wired by the graph's own rules (canConnect, through
 * planCanvasOps) against the canvas as it is; the ones it links, finds linked,
 * or refuses for good are recorded on their card in the same batch.
 * Deterministic: the same canvas and board give the same batch and op id.
 */
export function planBoardImport(canvas: TeamCanvas, graph: BoardGraph, ctx: ImportContext, author: string, limits: ImportLimits = IMPORT_BATCH): ImportBatch {
  const at = boardPlacement(canvas, ctx.boardId, graph.nodes);
  const cards = cardStates(canvas, graph, ctx.boardId);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const idOf = (id: string) => importedNodeId(ctx.boardId, id);
  const into = new Map<string, WirePair[]>();
  for (const pair of graph.pairs) into.set(pair.to, [...(into.get(pair.to) ?? []), pair]);

  /* The cards: as many as fit, each with room in the batch for the inputs it takes now (the first always goes). */
  const making: BoardNode[] = [];
  const made = new Set<string>();
  let room = Math.max(0, limits.wires);
  for (const node of importOrder(graph)) {
    if (making.length >= Math.max(0, limits.cards)) break;
    if (cards.get(node.id) !== "new") continue;
    const takes = (into.get(node.id) ?? []).filter((pair) => cards.get(pair.from) === "here" || made.has(pair.from)).length;
    if (making.length && takes > room) break;
    making.push(node);
    made.add(node.id);
    room = Math.max(0, room - takes);
  }
  const liveAfter = (id: string) => cards.get(id) === "here" || made.has(id);

  /* The inputs: the new cards' own first, then those into cards already here. */
  const wiring: WirePair[] = [];
  const pending = new Map<string, number>();
  const consider = (pair: WirePair) => {
    if (wiring.length >= Math.max(0, limits.wires) || !liveAfter(pair.from) || !liveAfter(pair.to)) return;
    /* A card already here: not an input it has handled, not locked (it waits), and room left in its record. */
    const target = canvas.nodes[idOf(pair.to)];
    if (target) {
      if (target.locked || importedOf(target)?.inputs?.some((input) => input?.from === pair.from)) return;
      if (!recordHasRoom(importedOf(target), { from: pair.from, slot: pair.slots.join(", ") })) return;
    }
    if ((importedOf(target)?.inputs?.length ?? 0) + (pending.get(pair.to) ?? 0) >= IMPORTED_INPUTS) return;
    pending.set(pair.to, (pending.get(pair.to) ?? 0) + 1);
    wiring.push(pair);
  };
  for (const node of making) for (const pair of into.get(node.id) ?? []) consider(pair);
  for (const pair of graph.pairs) if (cards.get(pair.to) === "here") consider(pair);

  /* A shot's LOOK slot fed by a look board: the scene names that board as its look, as the Rig's own shots do. */
  const looks = new Map<string, string>();
  for (const pair of graph.pairs) {
    if (!made.has(pair.to) || !pair.slots.includes("look") || !liveAfter(pair.from) || looks.has(pair.to)) continue;
    const source = byId.get(pair.from), element = source?.ref?.elementId ? ctx.elements.get(source.ref.elementId)?.kind : undefined;
    if (source?.kind === "asset" && importedShape("asset", element ?? String(source.settings?.kind ?? "")).type === "moodboard") looks.set(pair.to, idOf(pair.from));
  }

  const creates = making.map((old): Extract<CanvasOp, { kind: "create" }> => {
    const { node, asset } = mapBoardNode(old, ctx, at, { look: looks.get(old.id) });
    return { kind: "create", node, ...(asset ? { assets: [asset] } : {}) };
  });
  const wires: CanvasOp[] = wiring.map((pair) => ({ kind: "wire", from: idOf(pair.from), to: idOf(pair.to) }));
  if (!creates.length && !wires.length) return { ops: [], opId: null, cards: 0, wires: 0 };

  /* What the canvas's own rules will do with each input (one outcome per operation: made cards start with no inputs). */
  const outcomes = planCanvasOps(canvas, [...creates, ...wires], author).outcomes.slice(creates.length);
  const records = new Map<string, ImportedInput[]>();
  let linked = 0;
  wiring.forEach((pair, index) => {
    const held = outcomes[index]?.held;
    if (held && heldForNow(held)) return;
    if (!held) linked++;
    const entry: ImportedInput = { from: pair.from, ...(pair.slots.length ? { slot: pair.slots.join(", ").slice(0, 120) } : {}), ...(held ? { held: held.slice(0, 200) } : {}) };
    const id = idOf(pair.to);
    records.set(id, [...(records.get(id) ?? []), entry]);
  });

  /* The record rides with the batch: on a card made now, in the card; on one already here, as its own field. */
  const record = (base: NodeImported | undefined, extra: ImportedInput[]): NodeImported => {
    let next: NodeImported = { ...(base ?? { board: ctx.boardId }), inputs: [...(base?.inputs ?? [])] };
    for (const entry of extra) if (recordHasRoom(next, entry)) next = { ...next, inputs: [...next.inputs!, entry] };
    return next;
  };
  const ops: CanvasOp[] = creates.map((op) => {
    const extra = records.get(op.node.id);
    return extra ? { ...op, node: { ...op.node, imported: record(op.node.imported, extra) } } : op;
  });
  ops.push(...wires);
  for (const [id, extra] of records) {
    const target = canvas.nodes[id];
    /* `imported` is a field only the import sets (canvas-ops-model SETTABLE_FIELDS). */
    if (target) ops.push({ kind: "set", nodeId: id, fields: { imported: record(importedOf(target), extra) } });
  }
  return { ops, opId: `import:${ctx.boardId}:${stableId("batch", JSON.stringify(ops))}`, cards: creates.length, wires: linked };
}
