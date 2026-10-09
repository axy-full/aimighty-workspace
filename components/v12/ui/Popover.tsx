"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";
import { useOverlay, useV12PortalRoot } from "./overlay";
import type { OverlayLayer } from "./overlay-stack";
import { place, placeStart, type Side } from "./place";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Puts focus back where it was when a layer closes, if it is still inside the layer or nowhere. */
export function useFocusReturn(open: boolean, panel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const node = panel.current;
    return () => {
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body || (node && node.contains(now)))) before.focus({ preventScroll: true });
    };
  }, [open, panel]);
}

/**
 * A popover beside the control that opened it: on the overlay stack (Esc, outside click), drawn above the page and
 * kept on screen. Focus moves into it and comes back to the control when it closes.
 */
export function Popover({ open, onClose, anchor, label, children, align = "start", side = "bottom", layer = "menu", role = "dialog", width, className, onKeyDown, autoFocus = true }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  /** "start" lines it up with the control's start edge (menus); "center" centres it (popovers). */
  align?: "start" | "center";
  side?: Side;
  layer?: OverlayLayer;
  role?: "dialog" | "menu";
  width?: number;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  autoFocus?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const portal = useV12PortalRoot();
  const [at, setAt] = useState<{ left: number; top: number; side: Side } | null>(null);
  useOverlay(layer, open, onClose, { refs: [panel, anchor], outside: true });
  useFocusReturn(open, panel);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (!panel.current || !anchor.current) return;
      const a = anchor.current.getBoundingClientRect();
      /* offsetWidth, not the bounding box: the box is mid-animation (scale .97) when it is measured. */
      const b = { width: panel.current.offsetWidth, height: panel.current.offsetHeight };
      const rect = { left: a.left, top: a.top, width: a.width, height: a.height };
      const box = { width: b.width, height: b.height };
      const view = { width: window.innerWidth, height: window.innerHeight };
      setAt(align === "start" && (side === "bottom" || side === "top") ? placeStart(rect, box, view) : place(rect, box, view, side));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, align, side, anchor]);

  useEffect(() => {
    if (!open || !at || !autoFocus || !panel.current) return;
    if (panel.current.contains(document.activeElement)) return;
    /* A menu starts on its first item that can be chosen; anything else on its first control. */
    const first = role === "menu" ? '[role="menuitem"]:not([aria-disabled="true"])' : FOCUSABLE;
    (panel.current.querySelector<HTMLElement>(first) ?? panel.current).focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it is first placed.
  }, [open, at === null]);

  const root = open ? portal : null;
  if (!root) return null;
  const style: CSSProperties = at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: "hidden" };
  if (width) style.width = width;
  return createPortal(
    <div ref={panel} role={role} aria-label={label} tabIndex={-1} className={["v12-pop", className].filter(Boolean).join(" ")}
      data-side={at?.side ?? side} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>,
    root,
  );
}

export type MenuItem =
  | { id: string; label: string; shortcut?: string; onSelect: () => void; disabled?: boolean; tone?: "danger"; hint?: ReactNode }
  | { separator: true; id: string };

/**
 * A menu: a popover of commands (role menu). ↑/↓, Home and End move, Enter or Space runs one and closes the menu, Tab
 * and Esc close it. A shortcut shown here is one that works (docs/redesign/inventory.md § 4.2: none drawn unwired).
 */
export function Menu({ open, onClose, anchor, label, items, side = "bottom", align = "start", width = 220 }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuItem[];
  side?: Side;
  align?: "start" | "center";
  width?: number;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? all.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(all.length - 1);
    /* Tab leaves the menu back on the control that opened it, so a dialog's own Tab trap still holds around it. */
    else if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(); anchor.current?.focus(); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={label} role="menu" side={side} align={align} width={width} onKeyDown={onKeyDown} className="v12-menu">
      {items.map((item) => "separator" in item ? <div key={item.id} role="separator" className="v12-menu-sep" /> : (
        <button key={item.id} type="button" role="menuitem" className="v12-menu-item" data-tone={item.tone} aria-disabled={item.disabled || undefined}
          tabIndex={-1} onClick={() => { if (item.disabled) return; onClose(); item.onSelect(); }}>
          <span className="v12-menu-label">{item.label}</span>
          {item.hint ? <span className="v12-menu-hint">{item.hint}</span> : null}
          {item.shortcut ? <Kbd keys={item.shortcut.split(" ")} /> : null}
        </button>
      ))}
    </Popover>
  );
}
