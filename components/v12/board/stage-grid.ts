"use client";
import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/board/types";
import { GRID_GAP, GRID_STAGES, evenHeights, gridColumns, gridShotSize, type GridSize } from "@/lib/v12/board/grid";
import type { CardDef } from "@/components/graphite/board/cards/types";
import { containerOf } from "@/components/graphite/board/layout-cards";
import { wellHeight } from "@/components/graphite/board/cards/take/TakeCard";

/**
 * The stage grid on today's board (redesign P2-b; lib/v12/board/grid.ts has the rules). Today's board draws its cards
 * through each card definition's size and container (components/graphite/board/layout-cards.ts); on a grid stage the
 * new interface hands it definitions that say "N across, 24 px apart" for the stage's groups and "260 wide, one height"
 * for its shot cards. The cards themselves, their actions and their data are today's: nothing else changes.
 */

/** The width of the stage's canvas (the new frame's stage column), followed as it changes; null while off. */
export function useStageColumns(on: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    let watch: ResizeObserver | null = null;
    let frame = 0;
    const attach = () => {
      const el = document.querySelector<HTMLElement>(".v12-stage-canvas");
      if (!el) { frame = requestAnimationFrame(attach); return; }
      const read = () => setWidth(Math.round(el.clientWidth));
      read();
      watch = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
      watch?.observe(el);
    };
    attach();
    return () => { cancelAnimationFrame(frame); watch?.disconnect(); };
  }, [on]);
  return on ? gridColumns(width ?? 0) : null;
}

/** Whether a stage is laid out on the grid. */
export const onGrid = (stageId: string | null | undefined) => Boolean(stageId && GRID_STAGES.has(stageId));

/**
 * The definitions a grid stage lays its cards out with: every group `columns` across with the grid's gap, and every
 * shot card 260 wide at the stage's one shot height. Everything else is the definition as it is.
 */
export function gridDefs(defs: ReadonlyMap<string, CardDef<unknown>>, cards: readonly BoardCard[], aspect: string, columns: number): ReadonlyMap<string, CardDef<unknown>> {
  const take = defs.get("take");
  const sizes = new Map<string, GridSize>();
  if (take) for (const card of cards) if (card.kind === "take") sizes.set(card.id, gridShotSize(take.size(card.data, { aspect }), (w) => wellHeight(w, aspect)));
  const even = evenHeights(sizes);
  /* A definition's size is asked by the card's data: the same object the layout passes back. */
  const byData = new WeakMap<object, GridSize>();
  for (const card of cards) { const s = even.get(card.id); if (s && card.data && typeof card.data === "object") byData.set(card.data as object, s); }
  const out = new Map(defs);
  if (take) {
    out.set("take", { ...take, size: (data, at) => (data && typeof data === "object" ? byData.get(data as object) : undefined) ?? gridShotSize(take.size(data, at), (w) => wellHeight(w, at.aspect)) });
  }
  const group = defs.get("group");
  if (group?.container) {
    out.set("group", {
      ...group,
      container: (data) => ({ ...containerOf(group, { data } as BoardCard)!, columns, gap: GRID_GAP }),
    });
  }
  return out;
}
