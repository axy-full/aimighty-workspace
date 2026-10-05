import type { BoardCard, BoardSource } from "@/lib/board/types";
import { boardCards } from "./set-board";
import { planCards } from "./set-plan";
import { shotCards } from "./set-shots";
import { cardDef, type CardDef, type CardSet } from "./types";

export { defineCard, cardDef } from "./types";
export type { AnyCardDef, BoardCtx, BoardDrop, BoardKindModule, CardDef, CardProps, CardSet, DropAction } from "./types";

/*
 * The card registry (stream 3's plan § 0.3). Every board kind's sets are
 * merged after stream 3's board set, in order:
 *
 *   - a later definition with the same `kind` replaces an earlier one, so the
 *     board set's plain fallbacks (a group frame, today's node kinds) give way
 *     to stream 4's and stream 5's cards as each lands;
 *   - a later card with the same `id` replaces an earlier one, so a set that
 *     draws a canvas node (its id is the node's) takes it over from the
 *     fallback without anyone else changing.
 *
 * Studio's own sets: stream 4's plan cards (questions, doc, looks, storyboard,
 * plan) and stream 5's shot cards (group, take, cast, cut, deliver).
 */
export const STUDIO_SETS: readonly CardSet[] = [planCards, shotCards];

export type Registry = {
  defs: ReadonlyMap<string, CardDef<unknown>>;
  /** The board's cards from the production as it is now; a card whose kind has no definition is left out. */
  derive: (src: BoardSource) => BoardCard[];
  List: CardSet["List"] | null;
};

export function buildRegistry(sets: readonly CardSet[]): Registry {
  const all = [boardCards, ...sets.filter((set) => set !== boardCards)];
  const defs = new Map<string, CardDef<unknown>>();
  for (const set of all) for (const def of set.defs) defs.set(def.kind, cardDef(def));
  const List = all.reduce<CardSet["List"] | null>((found, set) => set.List ?? found, null);
  return {
    defs,
    List,
    derive: (src) => {
      const cards = new Map<string, BoardCard>();
      for (const set of all) {
        for (const card of set.derive(src)) {
          if (!defs.has(card.kind)) continue;
          /* Replaced in place, so the board's order of first appearance stays stable. */
          cards.set(card.id, card);
        }
      }
      return [...cards.values()];
    },
  };
}

