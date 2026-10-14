"use client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { fitBoardTabs } from "./tabs";

/** useLayoutEffect on the client (measures before paint), a plain effect where there is no layout to measure. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The width a "+N ▾" button takes before one has been drawn to measure. */
const MORE_WIDTH = 56;
/** A progress ring is wider than the dot the measuring copy draws. */
const RING_EXTRA = 6;

const px = (value: string) => Number.parseFloat(value) || 0;

/** The count that fits right now, read from the header's layout (null when its parts are not there yet). */
function measureFit(root: HTMLElement, open: readonly string[], active: string | null, more: { current: number }): number | null {
  const style = getComputedStyle(root);
  const inner = root.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  const gap = px(style.columnGap);
  const logo = root.querySelector<HTMLElement>(".v12-logo");
  const right = root.querySelector<HTMLElement>(".v12-right");
  const nav = root.querySelector<HTMLElement>(".v12-tabs");
  const field = root.querySelector<HTMLElement>(".v12-field");
  if (!logo || !right || !nav || !field) return null;
  const navStyle = getComputedStyle(nav);
  const navGap = px(navStyle.columnGap);
  const fixed = [...nav.children].filter((el) => !el.matches('[data-testid="v12-tab-board"], .v12-tab-more')) as HTMLElement[];
  const moreEl = nav.querySelector<HTMLElement>(".v12-tab-more");
  if (moreEl) more.current = moreEl.getBoundingClientRect().width;
  const base = px(navStyle.paddingLeft) + px(navStyle.paddingRight) + fixed.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) + navGap * Math.max(0, fixed.length - 1);
  const room = inner - logo.getBoundingClientRect().width - right.getBoundingClientRect().width - px(getComputedStyle(field).minWidth) - gap * 4 - px(navStyle.marginLeft) - base - 1;
  const widths: Record<string, number> = {};
  for (const el of root.querySelectorAll<HTMLElement>(".v12-tabs-measure [data-m]")) widths[el.dataset.m ?? ""] = el.getBoundingClientRect().width + RING_EXTRA + navGap;
  return fitBoardTabs({ open, active, widths, moreWidth: more.current + navGap, room });
}

/**
 * How many board tabs fit in the header (prototype v14: the field shrinks first, to 280 px, then the tabs go under "+N ▾"; the
 * Activity pill and the avatar never move). It measures real space, not a width per tab: the header's inner width, the logo, the
 * right group, the field's minimum, the fixed tabs (Home, Make, +), and each open board's tab as it would draw, from a hidden copy
 * (`.v12-tabs-measure`, one `[data-m]` per board). Re-measured when the window, the right group or the copy changes size.
 * `null` until measured, or until `ready` (every open board named): the header then shows its default count.
 */
export function useTabFit(header: RefObject<HTMLElement | null>, open: readonly string[], active: string | null, ready = true): number | null {
  const [fit, setFit] = useState<number | null>(null);
  const latest = useRef({ open, active });
  const moreWidth = useRef(MORE_WIDTH);

  const measure = () => {
    const root = header.current;
    if (!root) return;
    const n = measureFit(root, latest.current.open, latest.current.active, moreWidth);
    if (n !== null) setFit((before) => (before === n ? before : n));
  };

  /* After every render (a tab, a name, the chip beside the avatar): reading a few widths is cheap, and setting the same count is no render. */
  useBeforePaint(() => { latest.current = { open, active }; measure(); });

  useEffect(() => {
    const root = header.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    for (const el of root.querySelectorAll(".v12-right, .v12-tabs-measure")) observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `measure` reads refs only; the observer is made once.
  }, [header]);

  /* Until every open board has its real name, the tabs are not measured: a board with no name yet is a short "Board", and counting it so would show every tab and then pull them back. */
  return ready ? fit : null;
}
