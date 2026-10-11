import { isKnownNodeType } from "@/lib/workbench/node-graph";
import { refKindOf } from "@/lib/workbench/ref-kind";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import { isSectionNode, sectionGroup } from "@/lib/workspace/rig-board";
import { isShotNode } from "@/lib/workspace/shots";
import type { BoardCard, CardState, RegionId, StudioRegion } from "./types";

/*
 * The board's regions (design/particl-graphite/README.md § 1.1): the outline
 * rail's sections, the bands they are laid out in, which card draws each of
 * today's canvas nodes, and how a region's cards roll up into the rail's
 * status. Pure.
 */

/** A rail entry: its region, its 12 px label and its 16 px icon (stroke path data, from the master). */
export type RailEntry = { id: RegionId; label: string; icon: string };

export const STUDIO_RAIL: readonly RailEntry[] = [
  { id: "brief", label: "Brief", icon: "M4 2h6l3 3v9H4zM10 2v3h3M6 8h4M6 11h4" },
  { id: "looks", label: "Looks", icon: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3" },
  { id: "storyboard", label: "Storyboard", icon: "M2 4h12v8H2zM2 7h12M5 4v8" },
  { id: "shots", label: "Shots", icon: "M2 4h8v8H2zM10 7l4-2v6l-4-2" },
  { id: "cast", label: "Cast", icon: "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" },
  { id: "cut", label: "Cut", icon: "M2 5h12M2 8h12M2 11h8" },
  { id: "deliver", label: "Deliver", icon: "M8 11V3M4 7l4-4 4 4M3 13h10" },
];

/** The Studio board's bands, top to bottom, as the master lays them out; regions in one band sit side by side. */
export const STUDIO_BANDS: readonly (readonly RegionId[])[] = [["looks"], ["brief", "storyboard"], ["shots"], ["cast"], ["cut", "deliver"], ["next"], ["made"]];

export const STUDIO_REGIONS: readonly StudioRegion[] = STUDIO_RAIL.map((entry) => entry.id as StudioRegion);

/**
 * The Studio board's group frames, by fixed id, so a stream's group replaces stream 3's fallback of the same id
 * (README § 3.1: Looks; Storyboard; Shots; "Cast, environment and elements"; "Cut and deliver"; "Where to next?"; "Made in Make").
 */
export const STUDIO_GROUP = {
  looks: "group:looks", storyboard: "group:storyboard", shots: "group:shots", cast: "group:cast", cut: "group:cut", next: "group:next", made: "group:made",
} as const;

/* ── Which card draws each of today's canvas nodes ─────────────────────── */

/** The card set that draws a node: stream 3's board set, stream 4's plan set or stream 5's shots set. */
export type NodeSet = "board" | "plan" | "shots";
/**
 * How the board draws one canvas node. `kind` null: not drawn (an input shown
 * on its shot, or an old Tidy's section title, which regions replace).
 * `region` null: a free card at the node's own x and y.
 */
export type NodeRole = { kind: string | null; region: RegionId | null; set: NodeSet };

const HIDDEN: NodeRole = { kind: null, region: null, set: "board" };
const CUT_TYPES = new Set(["merge", "grade", "transform", "audio", "switch", "review"]);

type Assets = Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>;

/**
 * The fixed table every set reads (stream 3's plan § 0.4), so no node is drawn
 * twice: shots and cast-kind references are stream 5's, look boards and brief
 * nodes stream 4's, the rest stream 3's.
 */
export function nodeRole(node: CanvasNode, nodes: readonly CanvasNode[], assets: Assets): NodeRole {
  if (!isKnownNodeType(node.type)) return { kind: "unknown", region: null, set: "board" };
  if (isSectionNode(node)) return sectionGroup(node.id) ? HIDDEN : { kind: "label", region: null, set: "board" };
  if (isShotNode(node)) return { kind: "take", region: "shots", set: "shots" };
  if (node.type === "moodboard") return { kind: "looks", region: "looks", set: "plan" };
  if (node.type === "brief") return { kind: "doc", region: "brief", set: "plan" };
  if (node.type === "note") return { kind: "note", region: null, set: "board" };
  if (node.type === "output") return { kind: "tool", region: "deliver", set: "board" };
  if (CUT_TYPES.has(node.type)) return { kind: "tool", region: "cut", set: "board" };
  const ref = refKindOf(node, assets);
  if (ref === "cast" || ref === "environment" || ref === "element" || node.type === "character") return { kind: "cast", region: "cast", set: "shots" };
  /* A plain reference wired into a shot is that shot's input: it shows on the shot, not as a card of its own. */
  if (nodes.some((other) => other.linked.includes(node.id))) return HIDDEN;
  return { kind: "media", region: null, set: "board" };
}

/** The nodes a set draws, in canvas order, each with its role. */
export function nodesForSet(project: Pick<Project, "nodes" | "assets" | "sharedAssets">, set: NodeSet): { node: CanvasNode; role: NodeRole }[] {
  return project.nodes.flatMap((node) => {
    const role = nodeRole(node, project.nodes, project);
    return role.kind && role.set === set ? [{ node, role }] : [];
  });
}

/* ── The rail's status per region ──────────────────────────────────────── */

export type RegionStatus = { state: CardState; count: number; summary: string; cards: number };

const RANK: Record<CardState, number> = { needs: 3, working: 2, done: 1, empty: 0 };
/** The rail's words for a section with nothing in it (the master's). */
export const NOTHING_YET = "Nothing yet";

/**
 * A region's status from its cards: needs (with the count summed) over
 * working over done over empty; the summary is the most urgent card's,
 * else the first card's that has one, else "Nothing yet".
 */
export function regionStatus(cards: readonly BoardCard[]): RegionStatus {
  let state: CardState = "empty", count = 0, summary: string | null = null, rank = -1;
  for (const card of cards) {
    if (card.state === "needs") count += Math.max(1, card.needs ?? 1);
    if (RANK[card.state] > RANK[state]) state = card.state;
    if (card.summary && RANK[card.state] > rank) { summary = card.summary; rank = RANK[card.state]; }
  }
  return { state, count, summary: summary ?? NOTHING_YET, cards: cards.length };
}

/** Every rail region's status, from the board's cards (a group counts towards its own region, its children towards theirs). */
export function railStatus(rail: readonly RailEntry[], cards: readonly BoardCard[]): Map<RegionId, RegionStatus> {
  const by = new Map<RegionId, BoardCard[]>();
  for (const card of cards) if (card.region) by.set(card.region, [...(by.get(card.region) ?? []), card]);
  return new Map(rail.map((entry) => [entry.id, regionStatus(by.get(entry.id) ?? [])]));
}
