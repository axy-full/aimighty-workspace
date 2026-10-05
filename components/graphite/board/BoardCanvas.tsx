"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, ReactFlow, SelectionMode, type NodeChange, type OnMoveEnd, type OnNodeDrag, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { BOARD_DOTS } from "@/lib/board/layout";
import { dropPlace, type FreeMove } from "@/lib/board/snap";
import type { BoardPoint } from "@/lib/board/types";
import { BoardNode, type BoardFlowNode } from "./BoardNode";
import type { BoardSelection } from "./cards/types";
import type { PlacedBoard } from "./layout-cards";

/*
 * The board's canvas on React Flow (@xyflow/react, MIT; S3 item 1): pan
 * (two-finger scroll, Space-drag, middle-drag), zoom (pinch, ⌘/Ctrl-scroll),
 * select (click, ⇧ adds) and lasso (drag on the empty canvas), over the dot
 * grid — React Flow's Background, an SVG pattern (README § 2: 1 px dots every
 * 24 px at .06; answer 4.3 Q5).
 *
 * The nodes are the layout's (lib/board/layout.ts): arranged cards never
 * move; a free card drags, shows where it will land on the dots (Alt: where
 * it is let go), and is saved through the Rig's draft when let go. Group
 * frames sit under their cards and let presses through to the canvas, so a
 * lasso or a pan starts anywhere on a group's empty space.
 */
const NODE_TYPES = { card: BoardNode };
const NO_EDGES: never[] = [];
/** Above this many cards only those in view render (a 4,000-card canvas stays smooth). */
const VISIBLE_ONLY_FROM = 150;

export type BoardCanvasProps = {
  placed: PlacedBoard;
  selection: BoardSelection;
  onSelect: (ids: ReadonlySet<string>, primary: string | null) => void;
  /** Free cards let go: their new places, already on the dots (or not, with Alt). */
  onFreeMoved: (moves: FreeMove[]) => void;
  readOnly: boolean;
  onMoveEnd: (viewport: Viewport) => void;
  onOpen: (id: string) => void;
  /** React Flow is ready to move its viewport (the first view waits for it). */
  onReady: () => void;
};

export function BoardCanvas({ placed, selection, onSelect, onFreeMoved, readOnly, onMoveEnd, onOpen, onReady }: BoardCanvasProps) {
  const [drag, setDrag] = useState<ReadonlyMap<string, BoardPoint>>(new Map());
  const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const alt = useRef(false);
  useEffect(() => {
    const track = (event: KeyboardEvent) => { alt.current = event.altKey; };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => { window.removeEventListener("keydown", track); window.removeEventListener("keyup", track); };
  }, []);

  const nodes = useMemo<BoardFlowNode[]>(() => placed.cards.flatMap((card) => {
    const box = placed.boxes.get(card.id);
    if (!box) return [];
    const container = placed.containers.has(card.id);
    const free = !card.region;
    return [{
      id: card.id,
      type: "card" as const,
      position: drag.get(card.id) ?? { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      data: {},
      selected: selection.ids.has(card.id),
      draggable: free && !readOnly,
      selectable: true,
      zIndex: container ? 0 : 1,
      ...(container ? { className: "bd-container" } : {}),
      ...(measured.get(card.id) ? { measured: measured.get(card.id) } : {}),
    }];
  }), [placed, drag, measured, selection, readOnly]);

  const onNodesChange = useCallback((changes: NodeChange<BoardFlowNode>[]) => {
    let picked: Set<string> | null = null;
    let primary = selection.primary;
    const moved = new Map<string, BoardPoint>();
    const sized = new Map<string, { width: number; height: number }>();
    for (const change of changes) {
      if (change.type === "select") {
        picked ??= new Set(selection.ids);
        if (change.selected) { picked.add(change.id); primary = change.id; } else picked.delete(change.id);
      } else if (change.type === "position" && change.position) {
        moved.set(change.id, dropPlace(change.position, alt.current));
      } else if (change.type === "dimensions" && change.dimensions) {
        sized.set(change.id, change.dimensions);
      }
    }
    if (picked) {
      /* A lasso picks cards, never the frames around them. */
      if (picked.size > 1) for (const id of [...picked]) if (placed.containers.has(id)) picked.delete(id);
      if (primary && !picked.has(primary)) primary = picked.size ? [...picked].at(-1)! : null;
      onSelect(picked, primary);
    }
    if (moved.size) setDrag((was) => new Map([...was, ...moved]));
    if (sized.size) setMeasured((was) => new Map([...was, ...sized]));
  }, [onSelect, placed.containers, selection]);

  const onNodeDragStop = useCallback<OnNodeDrag<BoardFlowNode>>((_event, _node, dragged) => {
    const moves: FreeMove[] = [];
    for (const node of dragged) {
      const at = drag.get(node.id);
      const card = placed.byId.get(node.id);
      if (at && card?.nodeId && !card.region) moves.push({ id: card.nodeId, x: at.x, y: at.y });
    }
    if (moves.length) onFreeMoved(moves);
    setDrag((was) => { const next = new Map(was); for (const node of dragged) next.delete(node.id); return next; });
  }, [drag, onFreeMoved, placed.byId]);

  const handleMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => onMoveEnd(viewport), [onMoveEnd]);

  return (
    <ReactFlow<BoardFlowNode>
      className="bd-flow"
      nodes={nodes}
      edges={NO_EDGES}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeDoubleClick={(_event, node) => onOpen(node.id)}
      onMoveEnd={handleMoveEnd}
      onInit={onReady}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      selectionOnDrag
      selectionMode={SelectionMode.Partial}
      multiSelectionKeyCode="Shift"
      panOnDrag={[1]}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      minZoom={0.25}
      maxZoom={2}
      onlyRenderVisibleElements={nodes.length > VISIBLE_ONLY_FROM}
      elevateNodesOnSelect={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={BOARD_DOTS} size={2} color="var(--gx-hair-soft)" bgColor="var(--gx-root)" />
    </ReactFlow>
  );
}
