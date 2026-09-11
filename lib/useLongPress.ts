"use client";

import { useRef, type PointerEvent as RPointerEvent } from "react";

/**
 * A long-press and a drag, told apart by the finger (design/particl-v2-
 * mobile/README.md, M3: "long-press opens the context menu sheet; drag
 * reorders"). Hold still for 500ms and the press fires at the point; move
 * more sideways than down before that and a drag begins (the page keeps
 * vertical scrolling for itself via `touch-action: pan-y`); move down and
 * it is a scroll, nothing fires. The drag follows the pointer with
 * `onDragMove(x, y)` and ends with `onDragEnd(x, y)` — the caller finds
 * what is under the finger.
 */
export function useLongPress({ onPress, onDragStart, onDragMove, onDragEnd, delay = 500 }: {
  onPress: (x: number, y: number) => void;
  onDragStart?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number) => void;
  onDragEnd?: (x: number, y: number) => void;
  delay?: number;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const dragging = useRef(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  return {
    onPointerDown: (e: RPointerEvent) => {
      if (e.pointerType === "mouse" || e.button !== 0) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging.current = false;
      clear();
      timer.current = setTimeout(() => { timer.current = null; if (start.current && !dragging.current) { onPress(start.current.x, start.current.y); start.current = null; } }, delay);
    },
    onPointerMove: (e: RPointerEvent) => {
      const s = start.current; if (!s) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (dragging.current) { onDragMove?.(e.clientX, e.clientY); return; }
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      clear();
      if (Math.abs(dx) > Math.abs(dy) && onDragStart) {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(s.id);
        onDragStart(e.clientX, e.clientY);
      } else {
        start.current = null;   // a scroll
      }
    },
    onPointerUp: (e: RPointerEvent) => {
      clear();
      if (dragging.current) { dragging.current = false; onDragEnd?.(e.clientX, e.clientY); }
      start.current = null;
    },
    onPointerCancel: () => { clear(); if (dragging.current) { dragging.current = false; onDragEnd?.(-1, -1); } start.current = null; },
  };
}
