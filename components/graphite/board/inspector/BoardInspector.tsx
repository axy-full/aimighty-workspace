"use client";
import { useEffect, type CSSProperties } from "react";
import type { BoardCard } from "@/lib/board/types";
import type { BoardCtx, CardDef } from "../cards/types";
import type { TakeCardData } from "../cards/take/shots-derive";
import { typingIn } from "../review/review-model";
import { TakeBody } from "./TakeBody";
import "./inspector.css";

/*
 * The Inspector (README § 3.1 frame k; § 1.1): 340 px over the board's right edge, open only while a card is
 * selected, beside the docked Atomik panel. A take (its card, frame g's card or its versions) gets frame k's body;
 * a card whose definition brings an Inspector body gets that; anything else the nearest-frame default: what the
 * card itself says. × and Esc close it.
 */

export type BoardInspectorProps = {
  ctx: BoardCtx;
  card: BoardCard | null;
  def: CardDef<unknown> | null;
  right: number;
  onClose: () => void;
};

const TAKE_KINDS = new Set(["take", "take-review", "versions"]);

function isTakeCard(card: BoardCard): card is BoardCard<TakeCardData> {
  return TAKE_KINDS.has(card.kind) && Boolean((card.data as Partial<TakeCardData> | null)?.row);
}

/** What any card says about itself, for kinds that bring no Inspector body. */
function DefaultBody({ card }: { card: BoardCard }) {
  const d = (card.data ?? {}) as Record<string, unknown>;
  const said = (k: string) => (typeof d[k] === "string" && (d[k] as string).trim() ? (d[k] as string).trim() : null);
  const title = said("title") ?? card.summary ?? null;
  const lines = [said("kicker"), said("line"), said("meta")].filter(Boolean) as string[];
  return (
    <div className="gx-insp-take" data-testid="insp-default">
      {title ? <div className="gx-insp-title">{title}</div> : null}
      {lines.length ? <div className="gx-insp-meta">{lines.join(" · ")}</div> : null}
      {said("text") ? <p className="gx-insp-prompt">{said("text")}</p> : null}
    </div>
  );
}

export function BoardInspector({ ctx, card, def, right, onClose }: BoardInspectorProps) {
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || typingIn(e.target)) return;
      if (document.querySelector('[data-testid="review-mode"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, onClose]);
  if (!card || card.kind === "group") return null;
  const Body = def?.Inspector;
  return (
    <aside className="gx-insp" style={{ "--gx-insp-right": `${right}px` } as CSSProperties} aria-label="Inspector" data-testid="board-inspector">
      <div className="gx-insp-head">
        <strong className="gx-insp-heading">Inspector</strong>
        <button type="button" className="gx-insp-x" onClick={onClose} aria-label="Close the Inspector" title="Close · Esc" data-testid="insp-close">×</button>
      </div>
      <div className="gx-insp-body">
        {isTakeCard(card) ? <TakeBody key={card.data.row.nodeId} row={card.data.row} ctx={ctx} />
          : Body ? <Body card={card} data={card.data} selected ctx={ctx} />
          : <DefaultBody card={card} />}
      </div>
    </aside>
  );
}
