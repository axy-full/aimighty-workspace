"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

/**
 * A long list or grid that keeps only what is on screen in the page (SOW §5:
 * a project with thousands of takes or shots must stay fast). Below
 * VIRTUAL_FROM items it renders exactly as a plain list would, so small
 * projects, and every test built on them, see no difference. Above it, rows
 * are laid out absolutely inside a sizer of the full height; the columns
 * follow the container's width the way `repeat(auto-fill, minmax(…))` would.
 */

export const VIRTUAL_FROM = 100;

type Layout = { columns: number } | { minColumnWidth: number };

export type VirtualItemsProps<T> = {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  layout: Layout;
  /** Space between columns and rows, in px, matching the list's own CSS gap. */
  gap: number;
  /** A row's height before it is measured. */
  estimateRowHeight: number;
  /** "self" when the list scrolls itself; "ancestor" when a page pane scrolls it. */
  scroll: "self" | "ancestor";
  className?: string;
  style?: CSSProperties;
  /** Attributes for the container (data-testid, role, aria-label …). */
  attrs?: Record<string, string | undefined>;
  /** Shown before the items, inside the container (a running tile, a note). */
  before?: ReactNode;
  /** Shown after the items, inside the container (an empty state). */
  after?: ReactNode;
  /** Scroll this item into view when it changes (keyboard selection). */
  revealKey?: string | null;
  /** Bumped to bring `revealKey` into view again when it has not changed ("Back to the takes"). */
  revealNonce?: number;
  /** "center" keeps the item clear of whatever is pinned over the scroller's edges (the phone's tab bar). */
  revealAlign?: "auto" | "center";
  /** The role each virtual row gets when the container is a list. */
  rowRole?: string;
  /** An item that takes a row to itself (a group's heading); its own CSS spans the grid (`grid-column: 1 / -1`). */
  wholeRow?: (item: T) => boolean;
  /** Items share a row only with neighbours of the same run: a new run (a group's takes, a batch) starts a new row. */
  runOf?: (item: T) => string;
  /** A whole row's height before it is measured (a heading is shorter than a row of cards). */
  estimateWholeRow?: number;
};

/**
 * The rows a windowed list lays out, as [first, end) item ranges: `columns`
 * items a row, except that a whole-row item has its row to itself and a new
 * run starts a new row. Without `wholeRow` and `runOf` every row is simply the
 * next `columns` items.
 */
export function rowRanges<T>(items: readonly T[], columns: number, wholeRow?: (item: T) => boolean, runOf?: (item: T) => string): [number, number][] {
  const rows: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    const end = i === items.length
      || i - start >= columns
      || Boolean(wholeRow?.(items[i]) || wholeRow?.(items[i - 1]))
      || Boolean(runOf && runOf(items[i]) !== runOf(items[i - 1]));
    if (end) { rows.push([start, i]); start = i; }
  }
  return items.length ? rows : [];
}

/** The nearest ancestor that really scrolls vertically: a wrapper that only scrolls
 *  sideways computes overflow-y:auto too, but grows with its content, so it is skipped. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

type WindowedList = Virtualizer<HTMLElement, Element>;
/* The windowed lists each scroller holds, so that a smooth move of the page can hold their corrections. */
const listsIn = new WeakMap<Element, Set<WindowedList>>();
/* The last smooth move started in each scroller: an older one never re-aims over a newer one. */
const movesIn = new WeakMap<Element, number>();
/* The person taking the scroll over while a move runs. */
const TAKE_OVER = ["wheel", "touchstart", "pointerdown"] as const;

/**
 * Scroll `el` smoothly into view: a page's own move to something the list
 * does not hold, such as the editor that opens above a long grid. A windowed
 * list corrects its scroller's position whenever it measures a row above the
 * fold that it had only estimated, and outside iOS (where virtual-core defers
 * the correction) that correction is an instant scroll, which ends a smooth
 * one where it stands: the page stays at the end of the grid and the editor
 * never comes into view. So every windowed list in that scroller leaves its
 * corrections out until the move is over; the move goes past those rows anyway.
 *
 * A target past the list (the Rig's Build from Storyboards, under its shots)
 * moves while the rows before it are measured on the way, and the move keeps
 * the destination it set out for, so it can end short. Then, unless the person
 * took the scroll over or a newer move started, the target is brought where
 * the move was sent and held there until the lists have measured what the
 * move mounted (settleOn).
 */
export function smoothScrollIntoView(el: Element | null | undefined, block: ScrollLogicalPosition = "start") {
  if (!el) return;
  const scroller = scrollParent(el as HTMLElement);
  const lists = scroller ? listsIn.get(scroller) : undefined;
  if (scroller && lists?.size) {
    const move = (movesIn.get(scroller) ?? 0) + 1;
    movesIn.set(scroller, move);
    holdCorrections(scroller, [...lists], (touched) => {
      if (!touched) settleOn(el, scroller, block, () => movesIn.get(scroller) === move);
    });
  }
  el.scrollIntoView({ block, behavior: "smooth" });
}

/* The frames a target must hold still where its move put it before the move is over, and the longest it is held. */
const SETTLED_FRAMES = 8;
const SETTLE_MS = 3000;

/**
 * The end of a move. A list corrects its scroller only for a row measured
 * above the fold; a row measured on screen moves everything under it. At the
 * foot of a scroller (Build from Storyboards, under 1,500 shots, can't reach
 * the top of the screen) the rows above the target are on screen, and as each
 * is measured taller than its estimate the target is pushed down, off the
 * screen. So once a frame the target is put back where `block` puts it, until
 * it has held still there for SETTLED_FRAMES frames: the lists have measured
 * what the move mounted. Never past SETTLE_MS, a newer move, or the person
 * taking the scroll over.
 */
function settleOn(el: Element, scroller: HTMLElement, block: ScrollLogicalPosition, current: () => boolean) {
  const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
  const until = performance.now() + SETTLE_MS;
  let touched = false, still = 0, last = Number.NaN;
  const took = () => { touched = true; };
  for (const type of TAKE_OVER) target.addEventListener(type, took, { passive: true });
  window.addEventListener("keydown", took);
  const step = () => {
    if (!touched && current() && el.isConnected && performance.now() < until) {
      el.scrollIntoView({ block });
      const top = el.getBoundingClientRect().top;
      still = Math.abs(top - last) < 1 ? still + 1 : 0;
      last = top;
      if (still < SETTLED_FRAMES) { requestAnimationFrame(step); return; }
    }
    for (const type of TAKE_OVER) target.removeEventListener(type, took);
    window.removeEventListener("keydown", took);
  };
  step();
}

/**
 * Until the scroller stops: its `scrollend`, or, where there is none, a moment without a scroll event (a move that never
 * started lets go the same way). `done` hears whether the person took the scroll over meanwhile.
 */
function holdCorrections(scroller: HTMLElement, lists: WindowedList[], done: (touched: boolean) => void) {
  const hold = () => false;
  for (const list of lists) list.shouldAdjustScrollPositionOnItemSizeChange = hold;
  const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
  const still = "onscrollend" in window ? 1000 : 250;
  let touched = false, scrolled = false;
  let timer = setTimeout(release, still);
  function moved() { scrolled = true; clearTimeout(timer); timer = setTimeout(release, still); }
  /* The end of this move, not of one before it that had yet to say so. */
  function ended() { if (scrolled) release(); }
  function took() { touched = true; }
  function release() {
    clearTimeout(timer);
    target.removeEventListener("scroll", moved);
    target.removeEventListener("scrollend", ended);
    for (const type of TAKE_OVER) target.removeEventListener(type, took);
    window.removeEventListener("keydown", took);
    /* A later move holds them with its own function: only this move lets go of its hold. */
    for (const list of lists) if (list.shouldAdjustScrollPositionOnItemSizeChange === hold) list.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    done(touched);
  }
  target.addEventListener("scroll", moved, { passive: true });
  target.addEventListener("scrollend", ended);
  for (const type of TAKE_OVER) target.addEventListener(type, took, { passive: true });
  window.addEventListener("keydown", took);
}

export function VirtualItems<T>(props: VirtualItemsProps<T>) {
  const { items, className, style, attrs, before, after } = props;
  if (items.length < VIRTUAL_FROM)
    return (
      <div className={className} style={style} {...attrs}>
        {before}
        {items.map((item, index) => (props.rowRole
          ? <div key={props.getKey(item)} role={props.rowRole}>{props.renderItem(item, index)}</div>
          : <Keyed key={props.getKey(item)}>{props.renderItem(item, index)}</Keyed>))}
        {after}
      </div>
    );
  return <Windowed {...props} />;
}

/** A fragment with a key, so a plain list keeps the exact DOM it had before. */
function Keyed({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function Windowed<T>({ items, getKey, renderItem, layout, gap, estimateRowHeight, scroll, className, style, attrs, before, after, revealKey, revealNonce, revealAlign = "auto", rowRole, wholeRow, runOf, estimateWholeRow }: VirtualItemsProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);

  /* How far down its scroller the list starts. */
  const settleMargin = useCallback((parent: HTMLElement | null) => {
    const box = sizer.current;
    const from = scroll === "self" ? container.current : parent;
    if (!box || !from) return;
    const offset = Math.round(box.getBoundingClientRect().top - from.getBoundingClientRect().top + from.scrollTop);
    setMargin((current) => (current === offset ? current : offset));
  }, [scroll]);
  /* Where the list sits inside whatever scrolls it, and how wide it is. */
  const place = useCallback(() => {
    const box = sizer.current;
    if (!box) return;
    const parent = scroll === "self" ? container.current : scrollParent(box);
    setScroller((current) => (current === parent ? current : parent));
    /* A scrollbar appearing narrows the list, which can change the columns, the height and so the
       scrollbar again; widths within a scrollbar's breadth are treated as the same, which ends that loop. */
    setWidth((current) => (current && Math.abs(current - box.clientWidth) < 24 ? current : box.clientWidth));
    settleMargin(parent);
  }, [scroll, settleMargin]);
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    const box = sizer.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(box);
    if (scroller && scroller !== document.scrollingElement) observer.observe(scroller);
    return () => observer.disconnect();
  }, [place, scroller]);
  /* Something above the list can grow or shrink without the list rendering (an editor opening over a grid):
     where the list starts is read again as the page scrolls, once a frame. */
  useEffect(() => {
    const target: HTMLElement | Window | null = scroller === document.scrollingElement ? window : scroller;
    if (!target) return;
    let frame = 0;
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; settleMargin(scroller); }); };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => { target.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame); };
  }, [settleMargin, scroller]);

  const columns = "columns" in layout
    ? Math.max(1, layout.columns)
    : Math.max(1, Math.floor((Math.max(width, layout.minColumnWidth) + gap) / (layout.minColumnWidth + gap)));
  const rows = useMemo(() => rowRanges(items, columns, wholeRow, runOf), [items, columns, wholeRow, runOf]);
  const whole = (row: number) => Boolean(wholeRow && rows[row] && wholeRow(items[rows[row][0]]));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: (row) => (estimateWholeRow != null && whole(row) ? estimateWholeRow : estimateRowHeight) + gap,
    /* With headings among the rows, a row keeps its measured height by what it holds, not where it sits:
       a filter that moves a heading into a row of cards does not lend the cards the heading's height. */
    getItemKey: wholeRow || runOf ? (row) => (rows[row] ? getKey(items[rows[row][0]]) : row) : undefined,
    overscan: 4,
    scrollMargin: margin,
  });
  /* Known to its scroller, so a smooth move of the page there can hold this list's corrections (smoothScrollIntoView). */
  useEffect(() => {
    if (!scroller) return;
    const lists = listsIn.get(scroller) ?? new Set<WindowedList>();
    listsIn.set(scroller, lists);
    lists.add(virtualizer);
    return () => { lists.delete(virtualizer); };
  }, [scroller, virtualizer]);

  /* Keyboard selection: bring the row holding the selected item into view. */
  useEffect(() => {
    if (!revealKey) return;
    const index = items.findIndex((item) => getKey(item) === revealKey);
    const row = rows.findIndex(([start, end]) => index >= start && index < end);
    if (row >= 0) virtualizer.scrollToIndex(row, { align: revealAlign });
    // Only when the selection itself changes, or a reveal is asked for again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, revealNonce]);

  const rowStyle: CSSProperties = { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingBottom: gap };
  return (
    <div ref={container} className={className} style={{ ...style, display: "block" }} data-virtual="on" {...attrs}>
      {before}
      <div ref={sizer} style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const [start, end] = rows[row.index] ?? [0, 0];
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              role={rowRole === "listitem" ? "presentation" : undefined}
              style={{ ...rowStyle, position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              {items.slice(start, end).map((item, offset) => (
                rowRole
                  ? <div key={getKey(item)} role={rowRole} aria-setsize={items.length} aria-posinset={start + offset + 1}>{renderItem(item, start + offset)}</div>
                  : <Keyed key={getKey(item)}>{renderItem(item, start + offset)}</Keyed>
              ))}
            </div>
          );
        })}
      </div>
      {after}
    </div>
  );
}
