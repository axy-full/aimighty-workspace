"use client";
import type { BoardCard, CardState } from "@/lib/board/types";
import type { BoardCtx } from "../cards/types";

/*
 * The List view of an Ads or Social board (and the phone's stand-in until its Record lands): every card of the board with its
 * section and where it stands, in the board's own words. Honest by construction: it lists what the cards say, no more.
 */
const WORDS: Record<CardState, string> = { empty: "Nothing yet", working: "Working", needs: "Needs you", done: "Done" };
const TONE: Record<CardState, string> = { empty: "", working: "blue", needs: "gold", done: "green" };
const REGION: Record<string, string> = {
  brand: "Brand", product: "Product", hooks: "Hooks", formats: "Formats", ads: "Ads", adapt: "Adapt", deliver: "Deliver", source: "Source", clips: "Clips", effects: "Effects", posts: "Posts",
};

export function KindList({ ctx, cards }: { ctx: BoardCtx; cards: readonly BoardCard[] }) {
  const rows = cards.filter((card) => card.kind !== "group" && card.region);
  return (
    <div className="bd-list" data-testid="board-list">
      <div className="bd-list-inner ab-list">
        <div className="bd-list-row bd-list-head ab-list-row" role="row"><span>Card</span><span>Section</span><span className="bd-list-state">State</span></div>
        {rows.length ? rows.map((card) => (
          <button key={card.id} type="button" className="bd-list-row ab-list-row" onClick={() => ctx.select(card.id)} aria-current={ctx.selection.ids.has(card.id) ? "true" : undefined}>
            <span>{card.summary ?? (card.data as { title?: string; name?: string } | null)?.title ?? (card.data as { name?: string } | null)?.name ?? card.id}</span>
            <span className="bd-soft">{REGION[card.region as string] ?? card.region}</span>
            <span className="bd-list-state" data-tone={TONE[card.state]}><i aria-hidden="true" />{WORDS[card.state]}</span>
          </button>
        )) : <p className="bd-quiet bd-list-empty">Nothing on this board yet.</p>}
      </div>
    </div>
  );
}
