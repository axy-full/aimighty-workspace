"use client";

import { createElement, type AllHTMLAttributes, type ElementType, type ReactNode, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { useLongPress } from "@/lib/useLongPress";

/**
 * A card that opens the context menu (CR1 §10): right-click on a desktop,
 * long-press on a phone — `onMenu(x, y)` either way. Renders whatever tag
 * the caller names, with the caller's own handlers and classes on it, so
 * an article, a button or a div grows the behaviour without a wrapper in
 * the DOM. A finger that moves before the hold scrolls as usual.
 */
type Props = AllHTMLAttributes<HTMLElement> & { as?: ElementType; onMenu: (x: number, y: number) => void; children?: ReactNode };

export default function Pressable({ as = "div", onMenu, onContextMenu, children, ...rest }: Props) {
  const press = useLongPress({ onPress: onMenu });
  return createElement(as, {
    ...rest,
    onContextMenu: (e: RMouseEvent<HTMLElement>) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); onContextMenu?.(e); },
    onPointerDown: (e: RPointerEvent<HTMLElement>) => { press.onPointerDown(e); rest.onPointerDown?.(e); },
    onPointerMove: (e: RPointerEvent<HTMLElement>) => { press.onPointerMove(e); rest.onPointerMove?.(e); },
    onPointerUp: (e: RPointerEvent<HTMLElement>) => { press.onPointerUp(e); rest.onPointerUp?.(e); },
    onPointerCancel: (e: RPointerEvent<HTMLElement>) => { press.onPointerCancel(); rest.onPointerCancel?.(e); },
  }, children);
}
