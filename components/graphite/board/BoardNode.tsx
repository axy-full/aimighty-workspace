"use client";
import { memo, type CSSProperties } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { useBoardInternals } from "./BoardContext";

/*
 * Every card on the board sits in this wrapper (React Flow's custom node):
 * its exact box from the layout, the selection ring (the accent; a
 * teammate's in their colour with their name; Atomik's with what it is
 * doing), and the card's own component inside. Cards never draw their own
 * selection and never import React Flow.
 */
export type BoardFlowNode = Node<Record<string, never>, "card">;

function BoardNodeImpl({ id, selected, dragging }: NodeProps<BoardFlowNode>) {
  const { placed, defs, ctx, watchers, atomik } = useBoardInternals();
  const card = placed.byId.get(id);
  const box = placed.boxes.get(id);
  const def = card ? defs.get(card.kind) : undefined;
  if (!card || !box || !def) return null;
  const container = placed.containers.has(id);
  const watcher = watchers.get(id);
  const agent = atomik?.card === id ? atomik : null;
  const ring = agent?.color ?? watcher?.color ?? null;
  const Card = def.Card;
  return (
    <div
      className="bd-node"
      data-card-id={card.id}
      data-card-kind={card.kind}
      data-container={container || undefined}
      data-free={card.region ? undefined : true}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-watched={ring ? true : undefined}
      style={{ width: box.w, height: box.h, ...(ring ? ({ "--bd-ring": ring } as CSSProperties) : {}) }}
    >
      {agent ? <span className="bd-tag" style={{ background: agent.color }}>Atomik · {agent.doing}</span>
        : watcher ? <span className="bd-tag" style={{ background: watcher.color }}>{watcher.name}</span> : null}
      <Card card={card} data={card.data} selected={selected} ctx={ctx} />
    </div>
  );
}

export const BoardNode = memo(BoardNodeImpl);
