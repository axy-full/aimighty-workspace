"use client";
import { useMemo, useState } from "react";
import type { BoardCard } from "@/lib/board/types";
import type { BoardCtx } from "../cards/types";
import { usePosts } from "../social/posts/posts-store";
import { stageRows } from "./rows";

/*
 * A stage's List (lib "one board, four lenses"): the stage's own cards as rows, in the List's existing row (the same markup and styles as the plain shot list in
 * cards/board/ShotList.tsx). Every card the Canvas draws for the stage is here, as one row or, for a brief, a cut, a delivery or a hook card, a row for each thing it
 * holds. A row selects its card on the board.
 */
export function StageList({ ctx, cards }: { ctx: BoardCtx; cards: readonly BoardCard[] }) {
  const posts = usePosts();
  const [now] = useState(() => Date.now());
  const rows = useMemo(() => stageRows(cards, { posts, now }), [cards, posts, now]);
  return (
    <div className="bd-list" data-testid="board-stage-list">
      <div className="bd-list-inner">
        <div className="bd-list-row bd-list-head" role="row">
          <span>#</span><span>Kind</span><span>Item</span><span>Detail</span><span>More</span><span className="bd-list-state">State</span>
        </div>
        {rows.map((row, i) => (
          <button key={row.id} type="button" className="bd-list-row" data-testid="board-stage-list-row" data-card-id={row.cardId ?? undefined} disabled={!row.cardId}
            onClick={() => row.cardId && ctx.select(row.cardId)} aria-current={row.cardId && ctx.selection.ids.has(row.cardId) ? "true" : undefined}>
            <span className="bd-mono bd-quiet">{String(i + 1).padStart(2, "0")}</span>
            <span className="bd-mono">{row.kind}</span>
            <span>{row.title || "—"}</span>
            <span className="bd-soft">{row.detail || "—"}</span>
            <span className="bd-soft">{row.more || "—"}</span>
            <span className="bd-list-state" data-tone={row.tone}><i aria-hidden="true" />{row.state}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
