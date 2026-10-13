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
 *  - a DRAWN card with no node of its own (a storyboard frame, a look's tile): what leaves is its take, the drawing: it is hidden, never erased, and goes
 *    to the Trash with its cost and bytes (the server does it). The frame or tile stays, empty, to be drawn again.
 * Everything else (the plan, the cut, Where next?, a group's frame, the versions list, a take under review) is not a thing that can be removed; it says why.
 */
export type TrashKindOfCard = "card" | "note" | "text" | "look" | "cast" | "reference" | "group" | "frame" | "beat";

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

/** The take drawn on a frame or a look's tile (its `genId`), the thing that is removed from such a card. */
export function drawnTake(card: Pick<BoardCard, "kind" | "data">): string | null {
  if (card.kind !== "frame" && card.kind !== "look") return null;
  const id = (card.data as { genId?: unknown } | null)?.genId;
  return typeof id === "string" && id ? id : null;
}

export type TrashRecord = { kind: TrashKindOfCard | "take"; itemId: string; label: string; payload: unknown };
export type RemovalPlan = {
  /** The draft after the nodes are removed (one edit); the same draft when there are none. */
  project: Project;
  /** What leaves the draft, whole, with the links to put back (restoreRemoved). */
  removed: RemovedShots | null;
  /** One Trash record per node removed (its payload is the node and the links other cards had to it). */
  records: TrashRecord[];
  /** The takes drawn on the frames and tiles selected: the server removes these. */
  takes: { cardId: string; genId: string; label: string }[];
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
  const takes: RemovalPlan["takes"] = [];
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
    const genId = drawnTake(card)!;
    const title = (card.data as { name?: string; title?: string; line?: string } | null);
    if (!takes.some((t) => t.genId === genId)) takes.push({ cardId: card.id, genId, label: (title?.name || title?.title || title?.line || "Drawing").toString().slice(0, 80) });
  }
  if (!nodeIds.length) return { project, removed: null, records: [], takes, refused, alsoGone: [] };
  const out = removeShots(project, nodeIds);
  const gone = out.removed.removed;
  const records: TrashRecord[] = gone.map((node) => ({
    kind: kindOf.get(node.id) ?? "card", itemId: node.id, label: labels.get(node.id) ?? labelOf(node),
    payload: { node, links: out.removed.links.filter((l) => l.linked.includes(node.id)).map((l) => ({ nodeId: l.nodeId, linked: l.linked })) },
  }));
  return { project: out.project, removed: out.removed, records, takes, refused, alsoGone: gone.map((n) => n.id).filter((id) => !nodeIds.includes(id)) };
}

/** The Undo of a planned removal: the nodes back with their links (one already back is left as it is). */
export function restoreRemoved(project: Project, removed: RemovedShots): Project {
  return restoreShots(project, removed);
}

/** Puts one Trash record's node back, with the links other cards had to it, onto a draft (the Trash's restore, on the browser's side). */
export function restoreRecord(project: Project, payload: unknown): Project {
  const p = payload as { node?: CanvasNode; links?: { nodeId: string; linked: string[] }[] } | null;
  if (!p || !p.node || !p.node.id) return project;
  return restoreShots(project, { removed: [p.node], links: Array.isArray(p.links) ? p.links : [] });
}

export { RigBuildError };
