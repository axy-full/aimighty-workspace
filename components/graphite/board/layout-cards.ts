import { layoutBoard, type BoardLayout, type ContainerSpec, type LayoutItem } from "@/lib/board/layout";
import type { BoardCard, RegionId } from "@/lib/board/types";
import type { CardDef } from "./cards/types";

/*
 * The board's cards, laid out (lib/board/layout.ts) with each definition's
 * size and container. A fallback group (stream 3's) whose cards another set
 * took over with a group of its own is left out rather than drawn empty.
 */
export type PlacedBoard = BoardLayout & { cards: readonly BoardCard[]; byId: ReadonlyMap<string, BoardCard>; containers: ReadonlySet<string> };

export function containerOf(def: CardDef<unknown> | undefined, card: BoardCard): ContainerSpec | null {
  if (!def?.container) return null;
  return typeof def.container === "function" ? def.container(card.data) : def.container;
}

export function placeBoard(all: readonly BoardCard[], defs: ReadonlyMap<string, CardDef<unknown>>, bands: readonly (readonly RegionId[])[], aspect: string): PlacedBoard {
  const held = new Set(all.flatMap((card) => (card.group ? [card.group] : [])));
  const cards = all.filter((card) => {
    const def = defs.get(card.kind);
    if (!def) return false;
    const fallback = (card.data as { fallback?: unknown } | null)?.fallback === true;
    return !(containerOf(def, card) && fallback && !held.has(card.id));
  });
  const containers = new Set<string>();
  const items: LayoutItem[] = cards.map((card) => {
    const def = defs.get(card.kind)!;
    const container = containerOf(def, card);
    if (container) containers.add(card.id);
    return {
      id: card.id, region: card.region, order: card.order, group: card.group, at: card.at,
      size: def.size(card.data, { aspect }), ...(container ? { container } : {}),
    };
  });
  const layout = layoutBoard(items, bands);
  return { ...layout, cards, byId: new Map(cards.map((card) => [card.id, card])), containers };
}
