"use client";
import { useEffect, useState } from "react";
import type { BoardCard } from "@/lib/board/types";
import { GRID_ACTIONS, GRID_CARD, GRID_GAP, GRID_STAGES, evenHeights, gridColumns, type GridSize } from "@/lib/v12/board/grid";
import type { CardDef } from "@/components/graphite/board/cards/types";
import { containerOf } from "@/components/graphite/board/layout-cards";
import { gridTakeHeight } from "@/components/graphite/board/cards/take/TakeCard";
import { gridCastHeight } from "@/components/graphite/board/cards/cast/CastCard";
import type { CastCardData } from "@/components/graphite/board/cards/cast/cast-model";
import { frameCardHeight } from "@/components/graphite/board/cards/storyboard/FrameCard";
import { REVIEW_GROUP } from "@/components/graphite/board/cards/take/shots-derive";
import "./stage-grid.css";
import type { FrameData } from "@/components/graphite/board/cards/plan/derive";

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

/** Room for a strip along the top of a frameless group: Atomik's Stop for a run, the one thing the group's label carried that nothing else shows. */
const STRIP = 36;

/**
 * The cards a grid stage lays out: today's, with
 *  - the review group (the take that waits, its versions) left out: a finished shot card carries Approve · Reject itself,
 *    and everything else the review card offered is in the card's review mode and Details;
 *  - the plan card out of the Storyboard group, so it sits under the grid at its own width (a group's columns are as wide as its widest card);
 *  - each shot, frame and group told it is drawn on the grid (`grid`), so it draws its card actions and no frame.
 */
export function gridCards(cards: readonly BoardCard[]): BoardCard[] {
  return cards
    .filter((card) => card.id !== REVIEW_GROUP && card.group !== REVIEW_GROUP)
    .map((card) => {
      if (card.kind === "plan" && card.group) return { ...card, group: undefined };
      if (card.kind === "take" || card.kind === "frame" || card.kind === "cast" || card.kind === "group") return { ...card, data: { ...(card.data as object), grid: true } };
      return card;
    });
}

/**
 * The definitions a grid stage lays its cards out with: every group `columns` across with the grid's gap and no frame,
 * every shot and frame card 260 wide at the stage's one height for its kind. Everything else is the definition as it is.
 */
export function gridDefs(defs: ReadonlyMap<string, CardDef<unknown>>, cards: readonly BoardCard[], aspect: string, columns: number): ReadonlyMap<string, CardDef<unknown>> {
  const out = new Map(defs);
  /* A definition's size is asked by the card's data: the same object the layout passes back. */
  const evened = (kind: string, height: (data: unknown) => number) => {
    const sizes = new Map<string, GridSize>();
    for (const card of cards) if (card.kind === kind) sizes.set(card.id, { w: GRID_CARD, h: height(card.data) });
    const byData = new WeakMap<object, GridSize>();
    for (const [id, size] of evenHeights(sizes)) {
      const card = cards.find((c) => c.id === id);
      if (card?.data && typeof card.data === "object") byData.set(card.data as object, size);
    }
    const def = defs.get(kind);
    if (def) out.set(kind, { ...def, size: (data) => (data && typeof data === "object" ? byData.get(data as object) : undefined) ?? { w: GRID_CARD, h: height(data) } });
  };
  evened("take", (data) => gridTakeHeight(data as Parameters<typeof gridTakeHeight>[0], aspect));
  evened("frame", (data) => {
    const frame = data as FrameData;
    const { lines } = frame;
    return frameCardHeight(GRID_CARD, aspect, frame) + (lines.offer || lines.running || lines.versions.length > 1 ? 0 : GRID_ACTIONS);
  });
  evened("cast", (data) => gridCastHeight(data as CastCardData, aspect));
  const group = defs.get("group");
  if (group?.container) {
    out.set("group", {
      ...group,
      container: (data) => {
        const base = containerOf(group, { data } as BoardCard)!;
        const strip = (data as { stop?: unknown } | null)?.stop ? STRIP : 0;
        return { ...base, columns, gap: GRID_GAP, pad: { top: strip, right: 0, bottom: 0, left: 0 } };
      },
    });
  }
  return out;
}

/**
 * How far the last row must stay clear of the stage column's bottom: the bar's height and its 20 px offset, and 24 px more
 * (the bottom safe area, as on Home), so the bottom-left Library button, the view switch and the bar never cover a card at the end of the scroll.
 */
export function bottomClear(): number {
  const column = document.querySelector<HTMLElement>(".v12-stage-canvas");
  const bar = document.querySelector<HTMLElement>(".v12-bd-bar");
  const base = column && bar ? Math.max(0, column.getBoundingClientRect().bottom - bar.getBoundingClientRect().top) : 72;
  return base + 24;
}
