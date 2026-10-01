import { ENVIRONMENT_CATEGORY } from "../production/environment";
import { nodeDef } from "./node-graph";
import { REF_KINDS, type Asset, type CanvasNode, type Project, type RefKind } from "./studio";

/*
 * The four reference kinds on the Rig (owner, 28 September: an agentic canvas,
 * with the product, character or place kept as the source of truth). A card
 * keeps its node type — `character`, `element` or `media` — and says what it is
 * to the production: Cast, Environment, Element or Ref. The kind a person (or,
 * later, Atomik or a master lock) chose is stored as `refKind`; a card that has
 * none is read from what it already holds, the same way in every window, so
 * nothing is rewritten and dropping the field goes back to that reading.
 */

/** The node types that are references with a kind. A look board keeps its own node type and is not one of them. */
export const REF_NODE_TYPES = ["character", "element", "media"] as const satisfies readonly CanvasNode["type"][];

export const REF_KIND_LABELS: Record<RefKind, string> = { cast: "Cast", environment: "Environment", element: "Element", ref: "Ref" };

export function isRefKind(value: unknown): value is RefKind {
  return typeof value === "string" && (REF_KINDS as readonly string[]).includes(value);
}

/** Whether a card is a reference that has a kind (a shot, a note, a look board or a card from a newer release is not). */
export function isReferenceNode(node: Pick<CanvasNode, "type">): boolean {
  return (REF_NODE_TYPES as readonly string[]).includes(node.type);
}

type Assets = Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>;

/**
 * What a reference card is. A stored kind wins. Otherwise: a character is Cast;
 * an element is an Environment when its source is filed as one (the Environment
 * stage files its plates that way) or the element it stands for is a location,
 * and an Element otherwise; any other reference (a media input) is a Ref.
 * Null for a card that is not a reference.
 *
 * `elementKindOf` answers for a card linked to an element (lib/elements.ts), when
 * the caller has the elements; without it only the source's filing is read.
 */
export function refKindOf(node: Pick<CanvasNode, "type" | "refKind" | "assetId" | "elementId">, project: Assets, elementKindOf?: (elementId: string) => string | null | undefined): RefKind | null {
  if (!isReferenceNode(node)) return null;
  if (isRefKind(node.refKind)) return node.refKind;
  if (node.type === "character") return "cast";
  if (node.type === "element") {
    const source = node.assetId ? assetOf(project, node.assetId) : undefined;
    if (source?.category === ENVIRONMENT_CATEGORY) return "environment";
    if (node.elementId && elementKindOf?.(node.elementId) === "location") return "environment";
    return "element";
  }
  return "ref";
}

/** Whether the card's kind is one a person chose (stored), rather than read from the card. */
export function refKindChosen(node: Pick<CanvasNode, "type" | "refKind">): boolean {
  return isReferenceNode(node) && isRefKind(node.refKind);
}

/** The word a card is shown under: its kind for a reference, "Section" for a section title on the board, its node type's label for anything else. */
export function cardLabel(node: Pick<CanvasNode, "type" | "refKind" | "assetId" | "elementId" | "mode">, project: Assets): string {
  const kind = refKindOf(node, project);
  if (kind) return REF_KIND_LABELS[kind];
  /* lib/workspace/rig-graph.ts isSectionNode, read here without importing the board's layout into every card reader. */
  return node.type === "note" && node.mode === "section" ? "Section" : nodeDef(node.type).label;
}

function assetOf(project: Assets, id: string): Asset | undefined {
  return project.assets.find((a) => a.id === id) ?? project.sharedAssets?.find((a) => a.id === id);
}

/**
 * A card with its kind set by a person. Refused (the reason, as a string) for a
 * card that is not a reference, one that is gone, or one that is locked.
 */
export function withRefKind(project: Project, nodeId: string, kind: RefKind): Project | string {
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node) return "That card is no longer on the canvas.";
  if (!isReferenceNode(node)) return "Only reference cards have a kind.";
  if (node.locked) return "Unlock this card before changing its kind.";
  if (node.refKind === kind) return project;
  return { ...project, nodes: project.nodes.map((n) => (n.id === nodeId ? { ...n, refKind: kind } : n)) };
}
