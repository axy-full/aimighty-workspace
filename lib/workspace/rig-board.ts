import { createNode, nodeDef, operationsFor } from "../workbench/node-graph";
import { PROJECT_LIMITS } from "../workbench/project-limits";
import { refKindOf } from "../workbench/ref-kind";
import { stableId } from "../workbench/stable-id";
import type { CanvasNode, Project } from "../workbench/studio";
import { RigBuildError } from "../production/rig-build";
import { cardHeight, cardWidth, graphEdges, isSectionNode, SECTION_MODE, SECTION_WIDTH } from "./rig-graph";

/*
 * The Rig board, laid out so a big board reads at a glance (owner, 28
 * September: an agentic canvas like Luma's). Pure, and the same in the browser
 * and on the server, where the team canvas's Tidy runs
 * (lib/workbench/canvas-ops-model.ts):
 *
 *  - Sections. A section title is a `note` card in `section` mode. Every other
 *    card sits in one section: the one a person filed it under (`section`,
 *    set by letting it go under that title), else its own kind's — Cast,
 *    Environment, Elements, Refs, Looks, Direction, Shots, Finishing, Review
 *    and output. A kind's title is made by the first Tidy a person presses
 *    that needs it, with an id made from the kind, so two windows never make
 *    two. (Atomik's build tidies only its own cards and makes no title: it
 *    places exactly the cards the person approved.)
 *  - Snap. A card let go lands on the 20 px grid; Alt places it freely.
 *  - Tidy. Each section is a block of columns under its title, left to right
 *    in the order above (a person's section beside the kind of card it holds),
 *    rows in canvas order, wrapping into bands below so the board stays wide
 *    rather than endless. Cards that must stay put (locked, or not this
 *    writer's to move) keep their place, and the rest flow around them.
 */

export { isSectionNode, SECTION_MODE } from "./rig-graph";

/** The board's grid: a card let go snaps to it, and Tidy lays every card out on it. */
export const BOARD_GRID = 20;
/** Where a card may sit (the node schema's own bounds). */
export const POSITION = { min: -10_000, max: 20_000 } as const;

/* ── Snap ─────────────────────────────────────────────────────────────── */

/** The nearest grid line (never -0). */
export function snapTo(value: number, grid = BOARD_GRID): number {
  const snapped = Math.round(value / grid) * grid;
  return snapped === 0 ? 0 : snapped;
}

export const clampPosition = (value: number) => Math.min(POSITION.max, Math.max(POSITION.min, value));

export type Point = { x: number; y: number };
export type Delta = { dx: number; dy: number };

/** Where a card dragged from `from` by `delta` board units lands: on the grid, or exactly where it was let go (`free`: Alt held). */
export function dropPlace(from: Point, delta: Delta, free = false): Point {
  const x = from.x + delta.dx, y = from.y + delta.dy;
  return free
    ? { x: clampPosition(Math.round(x)), y: clampPosition(Math.round(y)) }
    : { x: clampPosition(snapTo(x)), y: clampPosition(snapTo(y)) };
}

/** The drag as drawn while the pointer moves: the card shows where it will land. */
export function dragShown(from: Point, delta: Delta, free = false): Delta {
  const to = dropPlace(from, delta, free);
  return { dx: to.x - from.x, dy: to.y - from.y };
}

/* ── Sections ─────────────────────────────────────────────────────────── */

/** The kinds of card a board is grouped by, left to right: references, then direction, shots and what follows them. */
export const BOARD_GROUPS = ["cast", "environment", "element", "ref", "look", "direction", "shots", "finishing", "output", "other"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];
export const BOARD_GROUP_TITLES: Record<BoardGroup, string> = {
  cast: "Cast", environment: "Environment", element: "Elements", ref: "Refs", look: "Looks", direction: "Direction",
  shots: "Shots", finishing: "Finishing", output: "Review and output", other: "Other cards",
};

type Assets = Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>;

/** The kind of card a card is on the board: a reference's kind (Cast, Environment, Element, Ref), else its node type's family. */
export function boardGroupOf(node: CanvasNode, assets: Assets): BoardGroup {
  const kind = refKindOf(node, assets);
  if (kind) return kind;
  switch (node.type as string) {
    case "moodboard": return "look";
    case "brief": case "note": return "direction";
    case "scene": case "generate": return "shots";
    case "merge": case "grade": case "transform": case "audio": return "finishing";
    case "switch": case "review": case "output": return "output";
    default: return "other";
  }
}

/** A kind's own section title: the same id in every window and on the server, so it is only ever made once. */
export const kindSectionId = (group: BoardGroup) => stableId("node", "board-section", group);
const KIND_SECTION = new Map<string, BoardGroup>(BOARD_GROUPS.map((group) => [kindSectionId(group), group]));
/** The kind a section title stands for, when it is a kind's own (null: a section a person made). */
export const sectionGroup = (id: string): BoardGroup | null => KIND_SECTION.get(id) ?? null;

export type BoardSection = {
  /** The section title card's id (a kind's own is made by Tidy when it is not on the board yet). */
  id: string;
  title: string;
  /** The kind a kind's own section gathers; null for a section a person made. */
  group: BoardGroup | null;
  /** Its title card, when it is on the board. */
  card: CanvasNode | null;
  /** The cards in it, in canvas order. */
  members: CanvasNode[];
};

/** The section a card sits in: the one it is filed under while that title is on the board, else its kind's. */
export function sectionOf(node: CanvasNode, titles: ReadonlySet<string>, assets: Assets): string {
  return node.section && titles.has(node.section) ? node.section : kindSectionId(boardGroupOf(node, assets));
}

/**
 * The board's sections in board order: every section title on the board (even
 * with nothing in it yet), and every kind that has a card but no title yet.
 * A kind's section keeps its place in BOARD_GROUPS; a section a person made
 * sits just after the kind of its first card (the end, while it is empty),
 * several such in the order they were made. `nodes` is in canvas order.
 */
export function boardSections(nodes: readonly CanvasNode[], assets: Assets): BoardSection[] {
  const titles = new Map(nodes.filter(isSectionNode).map((n) => [n.id, n]));
  const ids = new Set(titles.keys());
  const sections = new Map<string, BoardSection>();
  const open = (id: string) => {
    let section = sections.get(id);
    if (!section) {
      const card = titles.get(id) ?? null, group = sectionGroup(id);
      section = { id, title: card?.title.trim() || (group ? BOARD_GROUP_TITLES[group] : "Section"), group, card, members: [] };
      sections.set(id, section);
    }
    return section;
  };
  for (const id of titles.keys()) open(id);
  for (const node of nodes) if (!isSectionNode(node)) open(sectionOf(node, ids, assets)).members.push(node);
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const rank = (s: BoardSection) => (s.group ? BOARD_GROUPS.indexOf(s.group) * 10
    : s.members.length ? BOARD_GROUPS.indexOf(boardGroupOf(s.members[0], assets)) * 10 + 5 : 1000);
  return [...sections.values()].sort((a, b) => rank(a) - rank(b) || (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ── Filing a card by letting it go under a section title ─────────────── */

/** How far below a section's last card (or its title, while empty) a card let go still joins it. */
const REACH = 240;

/**
 * The section a card let go at `place` joins: the nearest title above it
 * whose column it is in, while it is no further than REACH below that
 * section's cards in that column. Null: under no title (its filing stays).
 */
export function sectionAt(nodes: readonly CanvasNode[], assets: Assets, cardId: string, place: Point): BoardSection | null {
  const card = nodes.find((n) => n.id === cardId);
  if (!card || isSectionNode(card)) return null;
  const centre = place.x + cardWidth(card) / 2;
  let best: BoardSection | null = null;
  for (const section of boardSections(nodes, assets)) {
    const title = section.card;
    if (!title) continue;
    const left = title.x - BOARD_GRID, right = title.x + cardWidth(title) + BOARD_GRID;
    if (centre < left || centre > right) continue;
    const column = section.members.filter((m) => m.id !== cardId && m.x + cardWidth(m) / 2 >= left && m.x + cardWidth(m) / 2 <= right);
    const floor = Math.max(title.y + TITLE_SLOT, ...column.map((m) => m.y + cardHeight(m))) + REACH;
    if (place.y < title.y + BOARD_GRID / 2 || place.y > floor) continue;
    if (!best || title.y > best.card!.y) best = section;
  }
  return best;
}

/**
 * What letting a card go at `place` does to its filing: under a section it
 * joins that section (its own kind's clears the filing, so it follows its
 * kind again); anywhere else it keeps what it had. Null: nothing changes.
 */
export function filingAt(nodes: readonly CanvasNode[], assets: Assets, cardId: string, place: Point): { section: string | undefined } | null {
  const card = nodes.find((n) => n.id === cardId);
  const section = card ? sectionAt(nodes, assets, cardId, place) : null;
  if (!card || !section) return null;
  const next = section.id === kindSectionId(boardGroupOf(card, assets)) ? undefined : section.id;
  return card.section === next ? null : { section: next };
}

/* ── What a card says at a glance ─────────────────────────────────────── */

export type CardTone = "green" | "gold" | "red" | "blue" | "floor";
/** A card's footer: its state in a word (none for a note), and the line beside it (the role, or a colour card's tools). */
export type CardStatus = { word: string | null; tone: CardTone; detail: string | null };

const SHOT_WORDS: Record<string, [string, CardTone]> = {
  approved: ["Approved", "green"], queued: ["Rendering", "gold"], ready: ["Ready", "gold"], failed: ["Failed", "red"], draft: ["Draft", "floor"],
};

/**
 * A card's state, as its footer says it: a shot's (Approved, Rendering, Ready,
 * Failed, Draft — the shot list's own reading); a reference's (approved,
 * ready once it holds a source, else no source yet); a finishing or flow
 * card's review state; nothing for a note, which is its words. A failed take
 * says only that it failed: what the provider billed is the Takes page's to say.
 */
export function cardStatus(node: CanvasNode, shotStatus: string | undefined, hasSource: boolean): CardStatus {
  const role = node.role || nodeDef(node.type).role || null;
  if (node.type === "grade") {
    const active = operationsFor(node).filter((op) => op.enabled).length;
    return { word: null, tone: "blue", detail: `${active.toLocaleString("en-US")} active ${active === 1 ? "tool" : "tools"}` };
  }
  if (shotStatus) {
    const [word, tone] = SHOT_WORDS[shotStatus] ?? SHOT_WORDS.draft;
    return { word, tone, detail: role };
  }
  const shape = nodeDef(node.type).shape;
  if (shape === "text") return { word: null, tone: "floor", detail: role };
  if (node.status === "approved") return { word: "Approved", tone: "green", detail: role };
  if (node.status === "review") return { word: "In review", tone: "gold", detail: role };
  if (shape === "reference") return hasSource ? { word: "Ready", tone: "gold", detail: role } : { word: "No source yet", tone: "floor", detail: role };
  return { word: hasSource ? "Ready" : "Draft", tone: hasSource ? "gold" : "floor", detail: role };
}

/* ── Edits a person makes on the board (through the Rig's own draft) ──── */

const assetsOf = (project: Project): Assets => ({ assets: project.assets, sharedAssets: project.sharedAssets });
const withNode = (project: Project, id: string, fn: (node: CanvasNode) => CanvasNode): Project =>
  ({ ...project, nodes: project.nodes.map((n) => (n.id === id ? fn(n) : n)) });

/**
 * A card let go after a drag: where it lands (on the grid unless `free`), and
 * the section it joins by landing under that section's title. The drag is
 * worked out on the card as the draft holds it now.
 */
export function dropCard(project: Project, id: string, delta: Delta, free = false): Project {
  const node = project.nodes.find((n) => n.id === id);
  if (!node) throw new RigBuildError("That card is no longer on the board.");
  if (node.locked) throw new RigBuildError("Unlock this card before moving it.");
  const place = dropPlace(node, delta, free);
  const filing = filingAt(project.nodes, assetsOf(project), id, place);
  if (place.x === node.x && place.y === node.y && !filing) return project;
  return withNode(project, id, (n) => {
    const next: CanvasNode = { ...n, x: place.x, y: place.y };
    if (filing) {
      if (filing.section) next.section = filing.section;
      else delete next.section;
    }
    return next;
  });
}

/** An open spot near `at` on the grid: a card already there moves the new one down and right, so two never stack. */
export function freeSpot(nodes: readonly CanvasNode[], at: Point): Point {
  let spot = { x: clampPosition(snapTo(at.x)), y: clampPosition(snapTo(at.y)) };
  for (let guard = 0; guard < 50 && nodes.some((n) => Math.abs(n.x - spot.x) < BOARD_GRID && Math.abs(n.y - spot.y) < BOARD_GRID); guard++)
    spot = { x: clampPosition(spot.x + 2 * BOARD_GRID), y: clampPosition(spot.y + 2 * BOARD_GRID) };
  return spot;
}

/** A new note or section title on the board at `at` (its top-left, snapped to an open spot). */
export function addBoardCard(project: Project, kind: "note" | "section", at: Point, id: string): Project {
  if (project.nodes.length >= PROJECT_LIMITS.nodes) throw new RigBuildError(`A board holds at most ${PROJECT_LIMITS.nodes.toLocaleString("en-US")} cards.`);
  if (project.nodes.some((n) => n.id === id)) return project;
  const spot = freeSpot(project.nodes, at);
  const card: CanvasNode = kind === "section"
    ? { id, title: "New section", type: "note", mode: SECTION_MODE, x: spot.x, y: spot.y, width: SECTION_WIDTH.made, linked: [] }
    : { ...createNode("note", project.nodes.length, spot), id, title: "Note", text: "", width: 254 };
  return { ...project, nodes: [...project.nodes, card] };
}

export const BOARD_TEXT_LIMITS = { title: 300, text: 30_000 } as const;

/** A note's words, or a section's (or any card's) name, edited on the board. */
export function withBoardText(project: Project, id: string, field: "title" | "text", value: string): Project {
  const node = project.nodes.find((n) => n.id === id);
  if (!node) throw new RigBuildError("That card is no longer on the board.");
  if (node.locked) throw new RigBuildError("Unlock this card before editing it.");
  if (field === "title") {
    const title = value.replace(/\s+/g, " ").trim();
    if (!title) throw new RigBuildError(isSectionNode(node) ? "Give the section a name." : "Give the card a name.");
    if (title.length > BOARD_TEXT_LIMITS.title) throw new RigBuildError(`Names are at most ${BOARD_TEXT_LIMITS.title} characters.`);
    return title === node.title ? project : withNode(project, id, (n) => ({ ...n, title }));
  }
  const text = value.replace(/\s+$/, "");
  if (text.length > BOARD_TEXT_LIMITS.text) throw new RigBuildError(`A note holds at most ${BOARD_TEXT_LIMITS.text.toLocaleString("en-US")} characters.`);
  return text === (node.text ?? "") ? project : withNode(project, id, (n) => ({ ...n, text }));
}

/* ── Tidy: the board by sections ──────────────────────────────────────── */

/** The layout's measures, in board units: all on the grid. */
export const TIDY = {
  left: 60, top: 60,
  /** One column of cards: the widest card (254) and the gap to the next. */
  column: 280,
  /** Between two sections' blocks. */
  sectionGap: 80,
  /** Between two bands of sections. */
  bandGap: 120,
  /** The title's row above a section's cards. */
  titleSlot: 80,
  /** At least this much between two cards in a column. */
  rowGap: 16,
} as const;
const TITLE_SLOT = TIDY.titleSlot;
/** How the layout grows for a bigger board, tried in turn until the board fits the canvas: cards per column, band width. */
const FITS: readonly (readonly [number, number])[] = [[5, 3600], [8, 6000], [12, 9600], [20, 14_000], [32, 19_000], [60, 19_000], [120, 19_000], [4000, 19_000]];

/** A card's row in a column: its height and the gap, rounded up to the grid. */
const slot = (height: number) => Math.ceil((height + TIDY.rowGap) / BOARD_GRID) * BOARD_GRID;
const titleWidth = (blockWidth: number) => Math.min(SECTION_WIDTH.max, Math.max(SECTION_WIDTH.min, blockWidth - BOARD_GRID));

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (n: CanvasNode): Box => ({ x: n.x, y: n.y, w: cardWidth(n), h: cardHeight(n) });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export type TidySpot = { id: string; x: number; y: number; width?: number };
export type TidyPlan = {
  /** Where each card goes (a section title's `width` spans its section's columns). */
  spots: TidySpot[];
  /** Kinds' section titles made by this Tidy, already in their spots. */
  made: CanvasNode[];
};

export type TidyOptions = {
  /** Whether this Tidy may move the card; one it may not keeps its place and the rest flow around it. Default: unlocked cards. */
  movable?: (node: CanvasNode) => boolean;
  /** Whether a kind's missing section title may be made (never one a person took off the board). Default: yes. */
  canMake?: (id: string) => boolean;
};

/**
 * The board by sections: a block of columns per section under its title,
 * left to right in board order, rows in canvas order (at most a few cards to
 * a column, the columns of a section evened out), blocks wrapping into bands
 * below. Everything lands on the grid. Cards that stay put are boxes the rest
 * step down past. For a board too big for the canvas at these measures the
 * columns grow taller and the bands wider until it fits.
 */
export function tidyBoard(nodes: readonly CanvasNode[], assets: Assets, options: TidyOptions = {}): TidyPlan {
  const movable = options.movable ?? ((n: CanvasNode) => !n.locked);
  const canMake = options.canMake ?? (() => true);
  const sections = boardSections(nodes, assets);
  const fixed = nodes.filter((n) => !movable(n)).map(boxOf);
  let plan: (TidyPlan & { right: number; bottom: number }) | null = null;
  for (const [rows, band] of FITS) {
    plan = layout(sections, fixed, movable, canMake, rows, band);
    if (plan.right <= POSITION.max && plan.bottom <= POSITION.max) break;
  }
  return { spots: plan!.spots, made: plan!.made };
}

function layout(
  sections: readonly BoardSection[], fixed: readonly Box[], movable: (n: CanvasNode) => boolean, canMake: (id: string) => boolean, rows: number, band: number,
) {
  const spots: TidySpot[] = [], made: CanvasNode[] = [];
  /* Down past anything that stays put: the first free place at or below `box`. */
  const clear = (box: Box): Box => {
    let at = box;
    for (let guard = 0; guard <= fixed.length; guard++) {
      const hit = fixed.find((f) => overlaps(at, f));
      if (!hit) break;
      at = { ...at, y: Math.ceil((hit.y + hit.h + TIDY.rowGap) / BOARD_GRID) * BOARD_GRID };
    }
    return at;
  };
  let x: number = TIDY.left, top: number = TIDY.top, bandBottom: number = TIDY.top, right: number = TIDY.left;
  for (const section of sections) {
    const cards = section.members.filter(movable);
    /* A kind's title is made only over cards this Tidy lays out: never a title over cards that stay where they are. */
    const title = section.card ? (movable(section.card) ? section.card : null) : section.group && cards.length && canMake(section.id) ? section : null;
    if (!cards.length && !title) continue;
    /* Columns evened out: 6 cards at 5 a column are 3 and 3, not 5 and 1. */
    const count = Math.max(1, Math.ceil(cards.length / rows)), per = Math.ceil(cards.length / count);
    const blockWidth = count * TIDY.column;
    if (x > TIDY.left && x + blockWidth > TIDY.left + band) {
      x = TIDY.left;
      top = bandBottom + TIDY.bandGap;
    }
    /* The cards start under the title's row, and under the title itself when something that stays put pushed it down. */
    let start = top + TITLE_SLOT;
    if (title) {
      const width = titleWidth(blockWidth);
      const at = clear({ x, y: top, w: width, h: cardHeight({ type: "note", mode: SECTION_MODE }) });
      if ("members" in title) made.push({ id: title.id, title: title.title, type: "note", mode: SECTION_MODE, x: at.x, y: at.y, width, linked: [] });
      else spots.push({ id: title.id, x: at.x, y: at.y, width });
      start = Math.max(start, at.y + TITLE_SLOT);
    }
    let bottom = start;
    for (let c = 0; c < count; c++) {
      let y = start;
      for (const card of cards.slice(c * per, (c + 1) * per)) {
        const at = clear({ x: x + c * TIDY.column, y, w: cardWidth(card), h: cardHeight(card) });
        spots.push({ id: card.id, x: at.x, y: at.y });
        y = at.y + slot(cardHeight(card));
      }
      bottom = Math.max(bottom, y);
    }
    right = Math.max(right, x + blockWidth);
    bandBottom = Math.max(bandBottom, bottom);
    x += blockWidth + TIDY.sectionGap;
  }
  return { spots, made, right, bottom: bandBottom };
}
