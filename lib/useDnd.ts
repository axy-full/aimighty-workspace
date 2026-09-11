"use client";

import { useCallback, useEffect, useId, useRef, useSyncExternalStore, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";

/**
 * Drag and drop on pointer events (docs/change-request-1.md §11): one
 * mechanism for a mouse and for a finger, so a take can be dragged onto
 * the composer's reference well with either. A mouse drags after 8px of
 * travel; a finger after a 500ms hold (a shorter touch scrolls, as usual).
 * The dragged card follows the pointer as a ghost; a target under the
 * pointer that accepts the payload's kind lights up (`over`), and the drop
 * lands on it. Targets register by `data-drop` id, so hit-testing is one
 * `elementFromPoint` per move. Desktop files keep the browser's own
 * drag-and-drop (`dataTransfer.files`), which pointer events do not see.
 */
export type DragPayload = { kind: "media" | "asset" | "reference" | "shot" | "node"; id: string; label: string; url?: string | null; data?: unknown };
type Target = { id: string; accepts: DragPayload["kind"][]; onDrop: (p: DragPayload) => void };
type State = { drag: DragPayload | null; x: number; y: number; over: string | null };

let state: State = { drag: null, x: 0, y: 0, over: null };
const targets = new Map<string, Target>();
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
export const useDnd = (): State => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state, () => state);

const targetUnder = (x: number, y: number, kind: DragPayload["kind"]): Target | null => {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  const t = el ? targets.get(el.dataset.drop ?? "") : null;
  return t && t.accepts.includes(kind) ? t : null;
};

/** A card that can be picked up. Spread the handlers on the card. */
export function useDragSource(payload: DragPayload | null, opts: { hold?: number; onStart?: () => void; onEnd?: () => void } = {}) {
  const start = useRef<{ x: number; y: number; id: number; timer: ReturnType<typeof setTimeout> | null; live: boolean } | null>(null);
  const swallowClick = useRef(false);
  const begin = useCallback((x: number, y: number) => {
    if (!payload) return;
    start.current!.live = true;
    set({ drag: payload, x, y, over: targetUnder(x, y, payload.kind)?.id ?? null });
    opts.onStart?.();
  }, [payload, opts]);
  const finish = useCallback((x: number, y: number, drop: boolean) => {
    const s = start.current; if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.live && state.drag) {
      const t = drop ? targetUnder(x, y, state.drag.kind) : null;
      const p = state.drag;
      set({ drag: null, over: null });
      t?.onDrop(p);
      opts.onEnd?.();
      swallowClick.current = true;
    }
    start.current = null;
  }, [opts]);
  return {
    onPointerDown: (e: RPointerEvent) => {
      if (!payload || e.button !== 0) return;
      const s = { x: e.clientX, y: e.clientY, id: e.pointerId, timer: null as ReturnType<typeof setTimeout> | null, live: false };
      start.current = s;
      if (e.pointerType === "touch") s.timer = setTimeout(() => { if (start.current === s && !s.live) { (e.currentTarget as HTMLElement).setPointerCapture?.(s.id); begin(s.x, s.y); } }, opts.hold ?? 500);
    },
    onPointerMove: (e: RPointerEvent) => {
      const s = start.current; if (!s) return;
      if (!s.live) {
        if (e.pointerType === "touch") { if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8 && s.timer) { clearTimeout(s.timer); s.timer = null; start.current = null; } return; }
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 8) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(s.id);
        begin(e.clientX, e.clientY);
      }
      if (s.live && state.drag) set({ x: e.clientX, y: e.clientY, over: targetUnder(e.clientX, e.clientY, state.drag.kind)?.id ?? null });
    },
    onPointerUp: (e: RPointerEvent) => finish(e.clientX, e.clientY, true),
    onPointerCancel: (e: RPointerEvent) => finish(e.clientX, e.clientY, false),
    /* The click a browser fires after the pointer comes up must not also open the card when it was a drag. */
    onClickCapture: (e: RMouseEvent) => { if (swallowClick.current) { swallowClick.current = false; e.stopPropagation(); e.preventDefault(); } },
  };
}

/** A place a payload can land. Spread `props` on the element; `over` says a drag is above it now. */
export function useDropTarget(accepts: DragPayload["kind"][], onDrop: (p: DragPayload) => void) {
  const id = useId();
  const latest = useRef(onDrop);
  useEffect(() => { latest.current = onDrop; });
  useEffect(() => {
    targets.set(id, { id, accepts, onDrop: (p) => latest.current(p) });
    return () => { targets.delete(id); };
  }, [id, accepts]);
  const s = useDnd();
  return { props: { "data-drop": id }, over: s.over === id && s.drag !== null && accepts.includes(s.drag.kind), dragging: s.drag !== null && accepts.includes(s.drag.kind) };
}
