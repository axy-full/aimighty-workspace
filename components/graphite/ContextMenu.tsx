"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { ctxItems, placeMenu, type CtxCapabilities, type CtxCommand } from "@/lib/shell/context-menu";
import { useShell } from "@/lib/shell/state";

/** Drawn at the cursor, flipped and clamped to the viewport; closes on click-away and Esc (the shell handles both). */
export function ContextMenu({ caps, onCommand }: { caps: CtxCapabilities; onCommand: (command: CtxCommand) => void }) {
  const shell = useShell();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ctx = shell.ctx;
  useLayoutEffect(() => {
    if (!ctx || !box.current) { setPos(null); return; }
    const r = box.current.getBoundingClientRect();
    setPos(placeMenu({ x: ctx.x, y: ctx.y }, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [ctx]);
  if (!ctx) return null;
  const items = ctxItems(ctx.target, caps);
  return (
    <div ref={box} className="gx-ctx" role="menu" aria-label="Context menu" data-testid="context-menu"
      style={{ left: pos?.left ?? ctx.x, top: pos?.top ?? ctx.y, visibility: pos ? "visible" : "hidden" }}
      onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="gx-ctx-title">{ctx.title}</div>
      {items.map((entry, i) => entry.sep ? <span key={i} className="gx-ctx-sep" role="separator" /> : (
        <button key={entry.command} type="button" role="menuitem" className="gx-ctx-item" data-danger={entry.danger ? "true" : undefined}
          disabled={entry.disabled} title={entry.reason} onClick={() => { shell.closeCtx(); onCommand(entry.command); }}>
          <span>{entry.label}</span>
          {entry.key ? <span className="gx-ctx-key">{entry.key}</span> : null}
        </button>
      ))}
    </div>
  );
}
