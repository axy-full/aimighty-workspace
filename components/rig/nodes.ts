import type { BoardNode, BoardWire, NodeKind } from "@/lib/boards";

/**
 * The geometry of board 6a (design/particl-v2/README.md §8), in the numbers
 * the Canvas and its wires share. Every node is `--card`, radius 12, a 1px
 * border, a 32px header (36 on a shot) with a 9.5px mono kind tag; widths
 * by kind; rows of fixed height so a dot — 8px, centred on the node's edge
 * — sits where the wire expects it. The board's own `top:` values are kept
 * verbatim (an asset's bundle dot at 12, a prompt's at 77, an image's at
 * 168, a video's at 161, a shot's SPEC at 141) and every point below is
 * that value plus the border plus half a dot.
 */
export const KIND_TAG: Record<NodeKind, string> = {
  asset: "AST", shot: "SHOT", prompt: "TXT", image: "IMG", video: "VID", edit: "EDT", upscale: "UPS", audio: "AUD", voice: "VOX", compare: "CMP", note: "NTE",
};
export const KIND_WORD: Record<NodeKind, string> = {
  asset: "Asset", shot: "Shot", prompt: "Prompt", image: "Image", video: "Video", edit: "Edit", upscale: "Upscale", audio: "Audio", voice: "Voice", compare: "Compare", note: "Note",
};
export const KINDS: NodeKind[] = ["asset", "shot", "prompt", "image", "video", "edit", "upscale", "audio", "voice", "compare", "note"];
export const GEN_KINDS: NodeKind[] = ["image", "video", "edit", "upscale", "audio", "voice", "compare"];
export const isGen = (k: NodeKind): boolean => GEN_KINDS.includes(k);

export const NODE_W: Record<NodeKind, number> = {
  asset: 200, shot: 250, prompt: 200, image: 250, video: 180, edit: 180, upscale: 180, audio: 180, voice: 180, compare: 250, note: 200,
};
export const BORDER = 1;
export const DOT = 8;
export const HEAD_H = 32;
export const SHOT_HEAD_H = 36;
export const PORT_ROW_H = 38;      // an asset's port row: a 32px tile + 6 under it
export const SLOT_ROW_H = 40;      // a shot's slot row
export const INPUT_ROW_H = 28;     // a generate node's input row
export const MOTION_H = 44;        // a video node's inline MOTION field
export const WELL_H = 89;          // a video node's output well
export const VARIANT_H = 64;       // one of an image node's 2×2 variants
export const SHOT_FOOT_H = 30;
export const TAKES_DOT_LEFT = 121; // the dashed TAKES dot on a shot's bottom edge

/** Where a node's output dot sits, as the board writes it: `top:` inside the padding box. */
export function outputDotTop(n: BoardNode): number {
  switch (n.kind) {
    case "asset": return 12;
    case "shot": return SHOT_HEAD_H + 8 + (n.inputs.length * SLOT_ROW_H) / 2 - 3;                              // 141 with five slots
    case "prompt": return 77;
    case "image": return HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + 8 + VARIANT_H;                             // 168
    case "video": return HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + MOTION_H + 8 + Math.round(WELL_H / 2) - 4;  // 161
    case "note": return -1;
    default: return HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + 8 + Math.round(WELL_H / 2) - 4;
  }
}

/** A shot node's full height, border to border. */
export const shotHeight = (n: BoardNode): number => BORDER + SHOT_HEAD_H + 8 + n.inputs.length * SLOT_ROW_H + 6 + SHOT_FOOT_H + BORDER;

/** Any node's full height, border to border — the same rows `Node` renders, for fitting the board into the viewport. */
export function nodeHeight(n: BoardNode): number {
  const BUTTON = 8 + 40 + 10;                                  // the Generate / Again button under a well, with its margins
  switch (n.kind) {
    case "asset": return BORDER + HEAD_H + n.ports.length * PORT_ROW_H + BORDER;
    case "shot": return shotHeight(n);
    case "prompt": case "note": return BORDER + HEAD_H + 96 + 10 + BORDER;
    case "image": return BORDER + HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + 8 + VARIANT_H * 2 + 6 + BUTTON + BORDER;
    case "video": return BORDER + HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + MOTION_H + 8 + WELL_H + BUTTON + BORDER;
    default: return BORDER + HEAD_H + 8 + n.inputs.length * INPUT_ROW_H + 8 + WELL_H + BUTTON + BORDER;
  }
}

/** The centre of a node's output dot, in board coordinates — a dot sits on the node's right edge (`right:-5px`), so the wire leaves from the edge itself. */
export function outputPoint(n: BoardNode): { x: number; y: number } {
  return { x: n.x + NODE_W[n.kind], y: n.y + BORDER + outputDotTop(n) + DOT / 2 };
}
/** A port's dot (an asset's port row). */
export function portPoint(n: BoardNode, portIndex: number): { x: number; y: number } {
  return { x: n.x + NODE_W[n.kind], y: n.y + BORDER + HEAD_H + portIndex * PORT_ROW_H + 12 + DOT / 2 };
}
/** The centre of a slot's dot (a shot's slot row, or a generate node's input row) — on the left edge (`left:-15px` in a 10px-padded row): a wire lands on the slot, not the node (§16, ±2px). */
export function slotPoint(n: BoardNode, slotIndex: number): { x: number; y: number } {
  if (n.kind === "shot") return { x: n.x, y: n.y + BORDER + SHOT_HEAD_H + 8 + slotIndex * SLOT_ROW_H + 16 + DOT / 2 };
  return { x: n.x, y: n.y + BORDER + HEAD_H + 8 + slotIndex * INPUT_ROW_H + 10 + DOT / 2 };
}
/** The centre of the dashed TAKES dot on a shot's bottom edge (`left:121px; bottom:-5px`). */
export function takesPoint(n: BoardNode): { x: number; y: number } {
  return { x: n.x + BORDER + TAKES_DOT_LEFT + DOT / 2, y: n.y + shotHeight(n) };
}

/** §8: cubic beziers from an output dot to an input dot. */
export function wirePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
/** The point half-way along that curve, for a label. */
export function wireMid(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
  const c1 = { x: a.x + dx, y: a.y }, c2 = { x: b.x - dx, y: b.y };
  return { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
}

export function endpoints(board: { nodes: BoardNode[] }, w: BoardWire): { a: { x: number; y: number }; b: { x: number; y: number } } | null {
  const from = board.nodes.find((n) => n.id === w.from.nodeId);
  const to = board.nodes.find((n) => n.id === w.to.nodeId);
  if (!from || !to) return null;
  const pi = from.ports.findIndex((p) => p.id === w.from.portId);
  const a = w.from.portId === "out" || pi < 0 ? outputPoint(from) : portPoint(from, pi);
  if (to.kind === "shot" && w.to.slotId === "takes") return { a, b: takesPoint(to) };
  const si = to.inputs.findIndex((i) => i.id === w.to.slotId);
  return { a, b: slotPoint(to, Math.max(0, si)) };
}

let seq = 0;
export const nid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The inputs a kind has (§8): a shot's five slots, a generate node's own. */
export function inputsFor(kind: NodeKind): BoardNode["inputs"] {
  switch (kind) {
    case "shot": return ["CHARACTER", "PROP", "BACKGROUND", "LOOK", "PROMPT"].map((l) => ({ id: l.toLowerCase(), label: l }));
    case "image": return [{ id: "spec", label: "SPEC" }, { id: "refs", label: "REFS" }];
    case "video": return [{ id: "image", label: "IMAGE" }];
    case "edit": case "upscale": return [{ id: "video", label: "VIDEO" }];
    case "audio": case "voice": return [{ id: "text", label: "TEXT" }];
    case "compare": return [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    default: return [];
  }
}

/** A fresh node of a kind, at a point, with the inputs its kind has. */
export function newNode(kind: NodeKind, x: number, y: number, extra: Partial<BoardNode> = {}): BoardNode {
  return { id: nid("nd"), kind, x, y, label: KIND_WORD[kind], ref: null, ports: [], inputs: inputsFor(kind), output: null, settings: {}, state: "idle", credits: 0, staleSince: null, text: "", ...extra };
}
