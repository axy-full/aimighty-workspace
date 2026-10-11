"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
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
export function Popover({ open, onClose, anchor, label, children, align = "start", side = "bottom", layer = "menu", role = "dialog", width, className, onKeyDown, autoFocus = true, focusPanel = false, testId }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  /** "start" lines it up with the control's start edge (menus), "end" with its end edge; "center" centres it (popovers). */
  align?: "start" | "center" | "end";
  testId?: string;
  side?: Side;
  layer?: OverlayLayer;
  role?: "dialog" | "menu";
  width?: number;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  autoFocus?: boolean;
  /** Focus goes to the panel itself, not its first control (a menu opened by a pointer: ↓ then reaches its first item). */
  focusPanel?: boolean;
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
      if (align === "center" || side === "left" || side === "right") { setAt(place(rect, box, view, side)); return; }
      const start = placeStart(rect, box, view);
      setAt(align === "end" ? { ...start, left: Math.round(Math.max(8, Math.min(rect.left + rect.width - box.width, view.width - 8 - box.width))) } : start);
    };
    measure();
    window.addEventListener("resize", measure);
    /* The control can move while the popover is open (a header still filling in its tabs): follow it, checking its
       place once a frame (one read, and a re-place only when it moved). */
    let frame = 0;
    let last = "";
    const follow = () => {
      const r = anchor.current?.getBoundingClientRect();
      const key = r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}` : "";
      if (key !== last) { last = key; measure(); }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => { window.removeEventListener("resize", measure); cancelAnimationFrame(frame); };
  }, [open, align, side, anchor, portal]);

  useEffect(() => {
    if (!open || !at || !autoFocus || !panel.current) return;
    if (panel.current.contains(document.activeElement)) return;
    /* A menu starts on its first item that can be chosen; anything else on its first control. */
    const first = role === "menu" ? '[role="menuitem"]:not([aria-disabled="true"])' : FOCUSABLE;
    ((focusPanel ? null : panel.current.querySelector<HTMLElement>(first)) ?? panel.current).focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it is first placed.
  }, [open, at === null]);

  const root = open ? portal : null;
  if (!root) return null;
  const style: CSSProperties = at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: "hidden" };
  if (width) style.width = width;
  return createPortal(
    <div ref={panel} role={role} aria-label={label} tabIndex={-1} className={["v12-pop", className].filter(Boolean).join(" ")}
      data-side={at?.side ?? side} data-testid={testId} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>,
    root,
  );
}

export type MenuItem =
  | {
      id: string; label: string; shortcut?: string; onSelect: () => void; disabled?: boolean; tone?: "danger" | "quiet"; hint?: ReactNode; testId?: string;
      /** A price drawn after the label, " · 43 cr" (the prototype's menus): the quote layer's <Price>, never a written figure. */
      price?: ReactNode;
      /** Opens a menu beside this item ("New ▸"): → or Enter opens it, ← or Esc comes back. `onSelect` is not called. */
      submenu?: readonly MenuItem[];
      /** Why the item is disabled, on hover. */
      title?: string;
    }
  | { separator: true; id: string };

/**
 * A menu: a popover of commands (role menu). ↑/↓, Home and End move, Enter or Space runs one and closes the menu, Tab
 * and Esc close it, → opens an item's submenu and ← closes it. A shortcut shown here is one that works (docs/redesign/
 * inventory.md § 4.2: none drawn unwired; lib/v12/keymap.ts has them all).
 */
export function Menu({ open, onClose, anchor, label, items, side = "bottom", align = "start", width = 220, head, testId, layer, focusPanel }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  items: readonly MenuItem[];
  side?: Side;
  align?: "start" | "center" | "end";
  width?: number;
  /** Drawn above the items (the account menu's balance row); its controls are reached with Tab, the items with ↑/↓. */
  head?: ReactNode;
  testId?: string;
  layer?: OverlayLayer;
  /** Opened by a pointer: focus the menu, not its first item (no focus ring on an item nobody chose); ↓ reaches it. */
  focusPanel?: boolean;
}) {
  const [sub, setSub] = useState<string | null>(null);
  const subAnchor = useRef<HTMLButtonElement | null>(null);
  const subItem = sub ? items.find((item) => !("separator" in item) && item.id === sub) : undefined;
  const subItems = subItem && !("separator" in subItem) ? subItem.submenu : undefined;
  /* A closed menu forgets its open submenu (set while rendering, as React advises for state that follows a prop). */
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) { setWasOpen(open); if (!open) setSub(null); }
  const openSub = (id: string, button: HTMLButtonElement) => { subAnchor.current = button; setSub(id); };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    /* A submenu's keys are its own (it is a child of this panel in the React tree, not in the page). */
    if (!event.currentTarget.contains(event.target as Node)) return;
    const all = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'));
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? all.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(all.length - 1);
    else if (event.key === "ArrowRight") {
      const here = all[at] as HTMLButtonElement | undefined;
      if (here?.dataset.sub) { event.preventDefault(); openSub(here.dataset.sub, here); }
    }
    /* Tab leaves the menu back on the control that opened it, so a dialog's own Tab trap still holds around it. */
    else if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); onClose(); anchor.current?.focus(); }
  };
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={label} role="menu" side={side} align={align} width={width} onKeyDown={onKeyDown} className="v12-menu" testId={testId} layer={layer} focusPanel={focusPanel}>
      {head}
      {items.map((item) => "separator" in item ? <div key={item.id} role="separator" className="v12-menu-sep" /> : (
        <button key={item.id} type="button" role="menuitem" className="v12-menu-item" data-tone={item.tone} data-testid={item.testId} aria-disabled={item.disabled || undefined}
          aria-haspopup={item.submenu ? "menu" : undefined} aria-expanded={item.submenu ? sub === item.id : undefined} data-sub={item.submenu ? item.id : undefined}
          title={item.title} data-item={item.id} tabIndex={-1}
          onClick={(e) => {
            if (item.disabled) return;
            if (item.submenu) { openSub(item.id, e.currentTarget); return; }
            onClose(); item.onSelect();
          }}>
          <span className="v12-menu-label">{item.label}{item.price ? <span className="v12-menu-price"> · {item.price}</span> : null}{item.submenu ? <span className="v12-menu-more" aria-hidden="true"> ▸</span> : null}</span>
          {item.hint ? <span className="v12-menu-hint">{item.hint}</span> : null}
          {item.shortcut ? <kbd className="v12-menu-key" aria-label={`Shortcut ${item.shortcut}`}>{item.shortcut}</kbd> : null}
        </button>
      ))}
      {subItems ? (
        <SubMenu anchor={subAnchor} label={subItem && !("separator" in subItem) ? subItem.label : label} items={subItems} width={width}
          onBack={() => { setSub(null); subAnchor.current?.focus(); }} onDone={() => { setSub(null); onClose(); }} layer={layer} />
      ) : null}
    </Popover>
  );
}

/** A submenu beside its item: ← or Esc closes it back onto the item; running one of its items closes both. */
function SubMenu({ anchor, label, items, width, onBack, onDone, layer }: {
  anchor: RefObject<HTMLButtonElement | null>; label: string; items: readonly MenuItem[]; width: number; onBack: () => void; onDone: () => void; layer?: OverlayLayer;
}) {
  const wrapped = items.map((item) => ("separator" in item ? item : { ...item, onSelect: () => { onDone(); item.onSelect(); } }));
  return (
    <div onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); onBack(); } }}>
      <Menu open onClose={onBack} anchor={anchor} label={label} items={wrapped} side="right" width={Math.min(width, 200)} layer={layer} testId="v12-submenu" />
    </div>
  );
}

/**
 * A menu at a point (a right-click): drawn at the cursor and kept on screen, on the overlay stack like every menu.
 * The point is a zero-size anchor at the cursor, so it places, flips and focuses as a menu under a control does.
 */
export function ContextMenu({ at, onClose, label, items, width = 260, testId }: {
  /** `pointer: false`: opened from the keyboard (the menu key, ⇧F10), so its first item takes focus. */
  at: { x: number; y: number; pointer?: boolean } | null;
  onClose: () => void;
  label: string;
  items: readonly MenuItem[];
  width?: number;
  testId?: string;
}) {
  const point = useRef<HTMLSpanElement>(null);
  const portal = useV12PortalRoot();
  if (!at || !portal) return null;
  return (
    <>
      {createPortal(<span ref={point} aria-hidden="true" className="v12-menu-point" style={{ left: at.x, top: at.y }} />, portal)}
      <Menu key={`${at.x},${at.y}`} open onClose={onClose} anchor={point} label={label} items={items} width={width} testId={testId} focusPanel={at.pointer !== false} />
    </>
  );
}
