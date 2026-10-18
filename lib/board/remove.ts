import type { BoardCard } from "./types";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import { removeShots, restoreShots, RigBuildError, type RemovedShots } from "@/lib/production/rig-build";

/**
 * What it takes to remove cards from a board (owner, 13 Oct 2026: "Delete everywhere"). Pure: the board's keys, its right-click and ⋯ menus and the Rig all
 * plan a removal here, then apply it as ONE draft edit and record it in the Trash (lib/boardTrash.ts).
 *
 * A card is removed one of two ways:
 *  - a NODE card (a shot, a reference, a look board, a brief, a note, a piece of text, a picture or video, a cut or deliver tool): its canvas node leaves the
 *    draft, with the links other cards had to it and the inputs only it used (removeShots, the Rig's own rule); the Trash keeps the node whole, so it comes
 *    back with those links.
 *  - a DRAWN card with no node of its own (a storyboard frame, a look's tile): what leaves is its drawing, the takes the draft holds on it (production.boards).
 *    The takes themselves stay in the Library, untouched (a take a draft uses cannot be hidden, and nothing is spent or erased); the frame or tile stays,
 *    empty, to be drawn again, and the Trash keeps the drawing whole so it comes back as it was.
 * Everything else (the plan, the cut, Where next?, a group's frame, the versions list, a take under review) is not a thing that can be removed; it says why.
 */
export type TrashKindOfCard = "card" | "note" | "text" | "look" | "cast" | "reference" | "group" | "frame" | "beat";
type Drawing = { scope: "frames" | "looks"; key: string; takes: unknown[]; selected: string | null };

const NODE_TRASH_KIND: Record<string, TrashKindOfCard> = { note: "note", label: "text", cast: "cast", looks: "look" };
const trashKindOf = (card: Pick<BoardCard, "kind">): TrashKindOfCard => NODE_TRASH_KIND[card.kind] ?? "card";

/** Why a card cannot be removed, in the words the board says; null when it can be. */
export function whyNotRemovable(card: Pick<BoardCard, "kind" | "nodeId" | "data" | "id">): string | null {
  if (card.nodeId) return null;
  if (drawnTake(card)) return null;
  switch (card.kind) {
    case "frame": case "look": return "Nothing is drawn on it yet, so there is nothing to remove.";
    case "group": return "A group frame is only the frame around its cards. Remove the cards in it.";
    case "plan": return "This is Atomik's plan. Decline or stop it from the plan itself.";
    case "cut": case "deliver": return "The cut and the delivery are made from your approved takes. Remove a take instead.";
    case "next": return "This is only a suggestion of where to go next.";
    case "versions": case "take-review": return "Take versions are removed from the take they belong to.";
    default: return "This card is made by the board from your work, so it cannot be removed on its own.";
  }
}
export const isRemovable = (card: Pick<BoardCard, "kind" | "nodeId" | "data" | "id">) => whyNotRemovable(card) === null;

/** The take drawn on a frame or a look's tile (its `genId`): what makes such a card removable. */
export function drawnTake(card: Pick<BoardCard, "kind" | "data">): string | null {
  if (card.kind !== "frame" && card.kind !== "look") return null;
  const id = (card.data as { genId?: unknown } | null)?.genId;
  return typeof id === "string" && id ? id : null;
}

type DrawnHolder = { takes: { genId: string }[]; selected?: string | null };
const holderOf = (project: Project, scope: Drawing["scope"], key: string): DrawnHolder | null => {
  const boards = project.production?.boards as unknown as Record<string, Record<string, DrawnHolder> | undefined> | undefined;
  return boards?.[scope]?.[key] ?? null;
};
const withHolder = (project: Project, scope: Drawing["scope"], key: string, next: DrawnHolder): Project => {
  const boards = project.production!.boards as unknown as Record<string, Record<string, DrawnHolder>>;
  return { ...project, production: { ...project.production!, boards: { ...project.production!.boards, [scope]: { ...boards[scope], [key]: next } } as never } };
};

/** The draft without a frame's or a look's drawing (all the takes it holds), and what to put back; null when the draft holds none. */
function clearDrawing(project: Project, card: Pick<BoardCard, "id" | "kind" | "data">): { project: Project; record: TrashRecord; drawing: Drawing } | null {
  const data = card.data as { shotId?: string; id?: string; name?: string; title?: string } | null;
  const scope: Drawing["scope"] = card.kind === "frame" ? "frames" : "looks";
  const key = card.kind === "frame" ? data?.shotId : data?.id;
  if (!key) return null;
  const held = holderOf(project, scope, key);
  if (!held || !held.takes.length) return null;
  const drawing: Drawing = { scope, key, takes: held.takes, selected: held.selected ?? null };
  const next = withHolder(project, scope, key, { ...held, takes: [], selected: null } as DrawnHolder);
  return { project: next, drawing, record: { kind: card.kind === "frame" ? "frame" : "look", itemId: card.id, label: (data?.name || data?.title || "Drawing").toString().slice(0, 80), payload: { drawing } } };
}

/** Puts a drawing back on its frame or look (the takes first, the pick as it was; one still there is left as it is). */
function restoreDrawing(project: Project, drawing: Drawing): Project {
  const held = holderOf(project, drawing.scope, drawing.key);
  if (!held) return project;
  const have = new Set(held.takes.map((t) => t.genId));
  const back = (drawing.takes as { genId: string }[]).filter((t) => !have.has(t.genId));
  if (!back.length) return project;
  return withHolder(project, drawing.scope, drawing.key, { ...held, takes: [...back, ...held.takes], selected: held.selected ?? drawing.selected } as DrawnHolder);
}

export type TrashRecord = { kind: TrashKindOfCard | "take"; itemId: string; label: string; payload: unknown };
/**
 * What the Trash keeps of one removal: ONE record for the whole step (the selection is one step, recorded and claimed back all or nothing). One item is recorded as
 * its own kind (a note, a look, a frame...), several as a "card" holding them all; `payload.items` is every item, whole, with the links other cards had to it.
 */
export function trashEntryOf(plan: Pick<RemovalPlan, "records">, id: string): TrashRecord | null {
  if (!plan.records.length) return null;
  const [first] = plan.records;
  return plan.records.length === 1
    ? { kind: first.kind, itemId: id, label: first.label, payload: { items: plan.records } }
    : { kind: "card", itemId: id, label: `${plan.records.length} cards`, payload: { items: plan.records } };
}

export type RemovalPlan = {
  /** The draft after the nodes are removed (one edit); the same draft when there are none. */
  project: Project;
  /** What leaves the draft, whole, with the links to put back (restoreRemoved). */
  removed: RemovedShots | null;
  /** One Trash record per node removed (its payload is the node and the links other cards had to it). */
  records: TrashRecord[];
  /** The drawings taken off the frames and tiles selected (to put back with the nodes). */
  drawings: Drawing[];
  /** What was asked and cannot be: the card and why. */
  refused: { id: string; why: string }[];
  /** Nodes that went because only the shots selected used them (an input made for a shot and used by nothing else). */
  alsoGone: string[];
};

const labelOf = (node: CanvasNode) => (node.title || node.text || node.type || "Card").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Plans removing `cards` from `project`, on ONE reading of the draft (the cards are all taken off together, so removing several at once never brings one
 * back). Nothing is applied here. A locked card refuses the whole removal with its own words (the Rig's rule).
 */
export function planRemoval(project: Project, cards: readonly Pick<BoardCard, "id" | "kind" | "nodeId" | "data">[]): RemovalPlan {
  const refused: RemovalPlan["refused"] = [];
  const drawn: Pick<BoardCard, "id" | "kind" | "nodeId" | "data">[] = [];
  const nodeIds: string[] = [];
  const kindOf = new Map<string, TrashKindOfCard>();
  const labels = new Map<string, string>();
  for (const card of cards) {
    const why = whyNotRemovable(card);
    if (why) { refused.push({ id: card.id, why }); continue; }
    if (card.nodeId) {
      if (!project.nodes.some((n) => n.id === card.nodeId)) { refused.push({ id: card.id, why: "That card is already gone." }); continue; }
      if (!nodeIds.includes(card.nodeId)) {
        nodeIds.push(card.nodeId); kindOf.set(card.nodeId, trashKindOf(card));
        const title = (card.data as { title?: unknown } | null)?.title;
        if (typeof title === "string" && title.trim()) labels.set(card.nodeId, title.replace(/\s+/g, " ").trim().slice(0, 80));
      }
      continue;
    }
    drawn.push(card);
  }
  let next = project;
  let removed: RemovedShots | null = null;
  let records: TrashRecord[] = [];
  let alsoGone: string[] = [];
  if (nodeIds.length) {
    const out = removeShots(project, nodeIds);
    next = out.project;
    removed = out.removed;
    const gone = out.removed.removed;
    records = gone.map((node) => ({
      kind: kindOf.get(node.id) ?? "card", itemId: node.id, label: labels.get(node.id) ?? labelOf(node),
      payload: { node, links: out.removed.links.filter((l) => l.linked.includes(node.id)).map((l) => ({ nodeId: l.nodeId, linked: l.linked })) },
    }));
    alsoGone = gone.map((n) => n.id).filter((id) => !nodeIds.includes(id));
  }
  const drawings: Drawing[] = [];
  for (const card of drawn) {
    const cleared = clearDrawing(next, card);
    if (!cleared) { refused.push({ id: card.id, why: "Nothing is drawn on it yet, so there is nothing to remove." }); continue; }
    next = cleared.project; records.push(cleared.record); drawings.push(cleared.drawing);
  }
  return { project: next, removed, records, drawings, refused, alsoGone };
}

/** The Undo of a planned removal: the nodes back with their links, the drawings back on their frames (one already back is left as it is). */
export function restoreRemoved(project: Project, plan: Pick<RemovalPlan, "removed" | "drawings">): Project {
  let next = plan.removed ? restoreShots(project, plan.removed) : project;
  for (const drawing of plan.drawings) next = restoreDrawing(next, drawing);
  return next;
}

/** Puts one Trash record's node back, with the links other cards had to it, onto a draft (the Trash's restore, on the browser's side). */
export function restoreRecord(project: Project, payload: unknown): Project {
  const p = payload as { node?: CanvasNode; links?: { nodeId: string; linked: string[] }[]; drawing?: Drawing; items?: { payload: unknown }[] } | null;
  /* A whole removal (trashEntryOf): each item back, in the order they were taken. */
  if (p?.items) return p.items.reduce((acc, item) => restoreRecord(acc, item.payload), project);
  if (p?.drawing) return restoreDrawing(project, p.drawing);
  if (!p || !p.node || !p.node.id) return project;
  return restoreShots(project, { removed: [p.node], links: Array.isArray(p.links) ? p.links : [] });
}

export { RigBuildError };
