"use client";

import { useCallback, useRef, useState } from "react";
import { clampWidth, usePaneWidth, type PaneSpec } from "@/lib/panes";

/**
 * The seam between a work surface and its rail (SOW §10 4.1).
 *
 * It sits on the boundary, absolutely positioned inside the rail, so no
 * layout has to make room for it — the grid stays two columns and the handle
 * straddles the line. Seven pixels wide because a one-pixel target is a
 * cursor hunt; only one of them is ever painted.
 *
 * Reachable without a mouse, which is the point of §10 4.2's argument and
 * not optional here: arrows nudge, shift-arrow moves in strides, Home and
 * End go to the stops, and Enter or a double-click puts it back where it
 * started. It carries `role="separator"` with the live value, so a screen
 * reader announces a resize rather than an unlabelled button.
 *
 * Below 1024 the rails are sheets rather than columns, so the handle is
 * display:none there — there is no seam to drag.
 */
export default function PaneDivider({ spec, label }: { spec: PaneSpec; label: string }) {
  const [width, setWidth] = usePaneWidth(spec);
  const [dragging, setDragging] = useState(false);
  const el = useRef<HTMLButtonElement>(null);

  /* The rail's right edge is fixed; the width is whatever is left of the
     pointer. Measured from the rail itself rather than from the window, so
     it stays right whatever sits to the right of it. */
  const widthFrom = useCallback((clientX: number) => {
    const rail = el.current?.parentElement;
    if (!rail) return width;
    return clampWidth(spec, rail.getBoundingClientRect().right - clientX, window.innerWidth);
  }, [spec, width]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();                       // don't start a text selection
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    setWidth(widthFrom(e.clientX));
  };

  const stop = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 12;
    // A rail on the right grows as it moves LEFT, which is the direction the
    // key names — ArrowLeft makes the rail bigger.
    if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(width + step); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setWidth(width - step); }
    else if (e.key === "Home") { e.preventDefault(); setWidth(spec.max); }
    else if (e.key === "End") { e.preventDefault(); setWidth(spec.min); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setWidth(spec.def); }
  };

  return (
    <button
      ref={el}
      type="button"
      className={`pane-div${dragging ? " is-drag" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label} width`}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      title={`Drag to resize · double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => setWidth(spec.def)}
      onKeyDown={onKeyDown}
    />
  );
}
