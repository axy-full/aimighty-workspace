import { nodeRole, STUDIO_GROUP, regionStatus } from "@/lib/board/regions";
import type { BoardCard, BoardSource, CardState, GroupData, RegionId } from "@/lib/board/types";
import { nodeDef, resolveAsset } from "@/lib/workbench/node-graph";
import { REF_KIND_LABELS, refKindOf } from "@/lib/workbench/ref-kind";
import type { Asset, CanvasNode } from "@/lib/workbench/studio";
import { cardStatus } from "@/lib/workspace/rig-board";
import { cardWidth } from "@/lib/workspace/rig-graph";
import { rigSubtitle, type RigShot } from "@/lib/workspace/shots";
import { GroupFrame, LabelCard, NodeCard, NoteCard, type LabelData, type NodeCardData, type NoteData, type Preview } from "./board/FallbackCards";
import { shotReferenceDrop } from "./accepts";
import { defineCard, type CardSet } from "./types";

/*
 * Stream 3's board set (plan § 0.3), merged first under every board kind:
 *
 *   - the board's own free cards: notes, labels (section titles a person made),
 *     uploads, and cards from a newer release (`unknown`);
 *   - plain cards for the finishing and flow nodes the design draws no frame
 *     for (`tool`, in Cut and Deliver);
 *   - fallbacks for the kinds streams 4 and 5 own (`take`, `cast`, `looks`,
 *     `doc`, the shared `group` frame), each replaced by that stream's
 *     definition, and each of these cards by that stream's card with the same
 *     id, as it lands.
 */

/* Sizes in board units: the design's widths (README § 3.1, the master). */
/* A media card is its well plus the body: eyebrow, a title of up to two lines and the state line (about 104 px). */
const BODY = 104;
export const NODE_SIZE = {
  take: { w: 340, h: 191 + BODY }, cast: { w: 308, h: 173 + BODY }, looks: { w: 462, h: 260 + BODY }, doc: { w: 220, h: 320 },
  tool: { w: 254, h: 132 }, media: { w: 220, h: 124 + BODY }, unknown: { w: 254, h: 132 }, note: { w: 254, h: 168 }, label: { h: 52 },
  /* The master's Made in Make card: a 308 px card, a 16:9 well, a title and one line. */
  made: { w: 308, h: 173 + 84 },
} as const;
const WELL = { take: 191, cast: 173, looks: 260, media: 124, made: 173 } as const;

/** A video or audio original (a stored upload or take) a card can be transcribed from. */
function transcribable(asset: Asset | undefined): { source?: NonNullable<NodeCardData["source"]> } {
  if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) return {};
  if (asset.generationId) return { source: { genId: asset.generationId, media: asset.kind } };
  if (asset.uploadId) return { source: { uploadId: asset.uploadId, media: asset.kind } };
  return {};
}

function preview(asset: Asset | undefined): Preview | null {
  if (!asset) return null;
  if (asset.kind === "video") {
    const url = asset.generationId ? `/api/media/${asset.generationId}` : asset.uploadId ? `/api/uploads/${asset.uploadId}` : asset.url;
    return url ? { url, video: true } : null;
  }
  const url = asset.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
    : asset.kind === "image" ? asset.url : "";
  return url ? { url, video: false } : null;
}

const MADE_GROUP = "group:made";
const SHOT_STATE: Record<string, CardState> = { approved: "done", queued: "working", failed: "needs" };

function nodeCard(node: CanvasNode, kind: string, region: RegionId | null, order: number, src: BoardSource, shot: RigShot | undefined): BoardCard {
  const { project } = src;
  const assets = [...project.assets, ...(project.sharedAssets ?? [])];
  const asset = resolveAsset(node, project.nodes, assets);
  const status = cardStatus(node, shot?.status, !!asset);
  const line = [status.word, status.detail].filter(Boolean).join(" · ") || null;
  if (kind === "note") return { id: node.id, kind, region: null, order, nodeId: node.id, at: { x: node.x, y: node.y }, state: "empty", data: { title: node.title, text: (node.text ?? "").trim() } satisfies NoteData };
  if (kind === "label") return { id: node.id, kind, region: null, order, nodeId: node.id, at: { x: node.x, y: node.y }, state: "empty", data: { title: node.title } satisfies LabelData };
  const ref = refKindOf(node, project);
  const master = !!node.elementId && src.masters.has(node.elementId);
  const kicker = kind === "take" ? `Shot ${shot?.index ?? order + 1}`
    : kind === "cast" ? `${ref ? REF_KIND_LABELS[ref] : "Cast"}${master ? " · master" : ""}`
    : kind === "looks" ? "Look" : kind === "doc" ? "Brief" : kind === "media" ? "Reference" : kind === "unknown" ? "Card" : nodeDef(node.type).label;
  const well = kind === "take" || kind === "cast" || kind === "looks" || kind === "media" || kind === "made" ? WELL[kind] : 0;
  const text = kind === "doc" || kind === "tool" || kind === "unknown" ? (node.text ?? "").trim() || (kind === "unknown" ? nodeDef(node.type).description : "") : "";
  const state: CardState = kind === "take" ? SHOT_STATE[shot?.status ?? ""] ?? "empty"
    : kind === "cast" || kind === "looks" ? (asset ? "done" : "empty")
    : kind === "doc" ? (text ? "done" : "empty")
    : kind === "tool" ? (node.status === "approved" ? "done" : "empty") : "empty";
  const data: NodeCardData = { kicker, title: node.title, line, tone: status.tone, text, preview: preview(asset), well, ...(kind === "media" ? transcribable(asset) : {}) };
  return { id: node.id, kind, region, order, nodeId: node.id, ...(region ? {} : { at: { x: node.x, y: node.y } }), state, data };
}

const GROUP_FOR: Partial<Record<string, { id: string; title: string; columns: number }>> = {
  take: { id: STUDIO_GROUP.shots, title: "Shots", columns: 2 },
  cast: { id: STUDIO_GROUP.cast, title: "Cast, environment and elements", columns: 3 },
  looks: { id: STUDIO_GROUP.looks, title: "Looks", columns: 2 },
  tool: { id: STUDIO_GROUP.cut, title: "Cut and deliver", columns: 3 },
};

function derive(src: BoardSource): BoardCard[] {
  const shots = new Map(src.shots.map((s) => [s.id, s]));
  const cards: BoardCard[] = [];
  src.project.nodes.forEach((node, order) => {
    const role = nodeRole(node, src.project.nodes, src.project);
    if (!role.kind) return;
    const card = nodeCard(node, role.kind, role.region, order, src, shots.get(node.id));
    const group = GROUP_FOR[role.kind];
    cards.push(group && card.region ? { ...card, group: group.id } : card);
  });
  /* The fallback groups, each only while it holds a card of this set's (a stream's own group of the same id replaces it). */
  for (const [kind, group] of Object.entries(GROUP_FOR)) {
    if (!group) continue;
    const members = cards.filter((card) => card.kind === kind && card.group === group.id);
    if (!members.length) continue;
    const roll = regionStatus(members);
    const meta = kind === "take" ? rigSubtitle(src.shots) : `${members.length.toLocaleString("en-US")} ${members.length === 1 ? "card" : "cards"}`;
    const data: GroupData = { title: group.title, meta, columns: group.columns, fallback: true };
    cards.push({ id: group.id, kind: "group", region: members[0].region, order: -1, state: roll.state, ...(roll.count ? { needs: roll.count } : {}), summary: meta, data });
  }
  return cards;
}

/** What Make filed while this board was open: the shot's node (Make files every take on a new shot node). */
export type MadeEntry = { nodeId: string };

/**
 * The "Made in Make" band (README § 3.2 `made`; the master's group of that name): a card for each result Make filed
 * while this board was open, in the order they came, each pointing at its shot. Session only, so it is never saved;
 * the shot itself stays in Shots, in its place. A result whose shot is not on the board yet waits for it.
 */
export function madeCards(src: BoardSource, made: readonly MadeEntry[]): BoardCard[] {
  const shots = new Map(src.shots.map((s) => [s.id, s]));
  const cards: BoardCard[] = [];
  made.forEach((entry, order) => {
    const node = src.project.nodes.find((n) => n.id === entry.nodeId);
    if (!node) return;
    const card = nodeCard(node, "take", "made", order, src, shots.get(node.id));
    const data = card.data as NodeCardData;
    cards.push({ ...card, id: `made:${node.id}`, kind: "made", group: MADE_GROUP, data: { ...data, kicker: "", well: WELL.made } satisfies NodeCardData });
  });
  if (!cards.length) return cards;
  const meta = `${cards.length.toLocaleString("en-US")} ${cards.length === 1 ? "card" : "cards"}`;
  const data: GroupData = { title: "Made in Make", meta, columns: 3, fallback: true };
  return [{ id: MADE_GROUP, kind: "group", region: "made", order: -1, state: "done", summary: meta, data }, ...cards];
}

const PLAIN = (kind: "take" | "made" | "cast" | "looks" | "doc" | "tool" | "media" | "unknown") =>
  defineCard<NodeCardData>({
    kind, size: () => NODE_SIZE[kind], Card: NodeCard,
    /* A still or a video dropped on a shot becomes its reference (rig-build's addInput, as the Rig's own library does). */
    ...(kind === "take" ? { accepts: shotReferenceDrop } : {}),
  });

export const boardCards: CardSet = {
  id: "board",
  defs: [
    PLAIN("take"), PLAIN("made"), PLAIN("cast"), PLAIN("looks"), PLAIN("doc"), PLAIN("tool"), PLAIN("media"), PLAIN("unknown"),
    defineCard<NoteData>({ kind: "note", size: () => NODE_SIZE.note, Card: NoteCard }),
    defineCard<LabelData>({ kind: "label", size: (data) => ({ w: cardWidth({ type: "note", mode: "section", width: Math.max(220, data.title.length * 9 + 48) }), h: NODE_SIZE.label.h }), Card: LabelCard }),
    defineCard<GroupData>({ kind: "group", size: () => ({ w: 240, h: 120 }), container: (data) => ({ columns: Number(data.columns) || 2, fill: true }), Card: GroupFrame }),
  ],
  derive,
};
