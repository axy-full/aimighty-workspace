"use client";
import { shotRows } from "@/lib/board/list";
import type { BoardCard } from "@/lib/board/types";
import type { BoardCtx } from "../types";

/*
 * The board's List view (the master's frame d with List picked): the same
 * board as an ordered shot list. Stream 4 owns the drawn, editable table
 * (lead decision 28) and replaces this plain one through its set's `List`.
 */
export function ShotList({ ctx }: { ctx: BoardCtx; cards: readonly BoardCard[] }) {
  const rows = shotRows(ctx.project, ctx.rig.shots);
  return (
    <div className="bd-list" data-testid="board-list">
      <div className="bd-list-inner">
        <div className="bd-list-row bd-list-head" role="row">
          <span>#</span><span>Time</span><span>Action</span><span>Size</span><span>Camera</span><span className="bd-list-state">State</span>
        </div>
        {rows.length ? rows.map((row) => (
          <button key={row.id} type="button" className="bd-list-row" disabled={!row.cardId} onClick={() => row.cardId && ctx.select(row.cardId)}
            aria-current={row.cardId && ctx.selection.ids.has(row.cardId) ? "true" : undefined}>
            <span className="bd-mono bd-quiet">{row.number}</span>
            <span className="bd-mono">{row.start ?? "—"}{row.seconds ? ` · ${row.seconds} s` : ""}</span>
            <span>{row.action || "—"}</span>
            <span className="bd-soft">{row.size || "—"}</span>
            <span className="bd-soft">{row.camera || "—"}</span>
            <span className="bd-list-state" data-tone={row.tone}><i aria-hidden="true" />{row.state}</span>
          </button>
        )) : <p className="bd-quiet bd-list-empty">No shots yet.</p>}
      </div>
    </div>
  );
}
