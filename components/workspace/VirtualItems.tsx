"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  /** The role each virtual row gets when the container is a list. */
  rowRole?: string;
};

/** The nearest ancestor that really scrolls vertically: a wrapper that only scrolls
 *  sideways computes overflow-y:auto too, but grows with its content, so it is skipped. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
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

function Windowed<T>({ items, getKey, renderItem, layout, gap, estimateRowHeight, scroll, className, style, attrs, before, after, revealKey, rowRole }: VirtualItemsProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);

  /* Where the list sits inside whatever scrolls it, and how wide it is. */
  const place = useCallback(() => {
    const box = sizer.current;
    if (!box) return;
    const parent = scroll === "self" ? container.current : scrollParent(box);
    setScroller((current) => (current === parent ? current : parent));
    /* A scrollbar appearing narrows the list, which can change the columns, the height and so the
       scrollbar again; widths within a scrollbar's breadth are treated as the same, which ends that loop. */
    setWidth((current) => (current && Math.abs(current - box.clientWidth) < 24 ? current : box.clientWidth));
    if (scroll === "ancestor" && parent) {
      const offset = Math.round(box.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
      setMargin((current) => (current === offset ? current : offset));
    } else if (scroll === "self" && container.current) {
      const offset = Math.round(box.getBoundingClientRect().top - container.current.getBoundingClientRect().top + container.current.scrollTop);
      setMargin((current) => (current === offset ? current : offset));
    }
  }, [scroll]);
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    const box = sizer.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(box);
    if (scroller && scroller !== document.scrollingElement) observer.observe(scroller);
    return () => observer.disconnect();
  }, [place, scroller]);

  const columns = "columns" in layout
    ? Math.max(1, layout.columns)
    : Math.max(1, Math.floor((Math.max(width, layout.minColumnWidth) + gap) / (layout.minColumnWidth + gap)));
  const rows = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller,
    estimateSize: () => estimateRowHeight + gap,
    overscan: 4,
    scrollMargin: margin,
  });

  /* Keyboard selection: bring the row holding the selected item into view. */
  useEffect(() => {
    if (!revealKey) return;
    const index = items.findIndex((item) => getKey(item) === revealKey);
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / columns), { align: "auto" });
    // Only when the selection itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  const rowStyle: CSSProperties = { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingBottom: gap };
  return (
    <div ref={container} className={className} style={{ ...style, display: "block" }} data-virtual="on" {...attrs}>
      {before}
      <div ref={sizer} style={{ position: "relative", width: "100%", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const start = row.index * columns;
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              role={rowRole === "listitem" ? "presentation" : undefined}
              style={{ ...rowStyle, position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              {items.slice(start, start + columns).map((item, offset) => (
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
