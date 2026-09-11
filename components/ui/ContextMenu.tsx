"use client";

import { useCallback, useEffect, useState, type MouseEvent as RMouseEvent, type ReactNode } from "react";
import Menu, { type MenuItem } from "./Menu";
import { useLongPress } from "@/lib/useLongPress";

/**
 * One context menu for everything (docs/change-request-1.md §10): the ten
 * items of `lib/contextMenu.ts` — right-click on a desktop, long-press on
 * a phone (where `Menu` already renders as a sheet). The keyboard
 * equivalents fire from `useCardKeys` while a card is selected. Every
 * action narrates in a toast; that is the caller's line.
 */
export { contextItems, CONTEXT_ORDER, type ContextActions } from "@/lib/contextMenu";
import type { ContextActions } from "@/lib/contextMenu";

export type ContextTarget<T> = { x: number; y: number; target: T; sub: "move" | "share" | null };

/**
 * The menu's state for one surface: `open(target, at)` from a right-click or
 * a long-press, `props(target)` to spread on a card (context-menu and the
 * phone's long-press), and `host` to render.
 */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<ContextTarget<T> | null>(null);
  const open = useCallback((target: T, x: number, y: number) => setMenu({ x, y, target, sub: null }), []);
  const close = useCallback(() => setMenu(null), []);
  const toggleSub = useCallback((which: "move" | "share") => setMenu((m) => m && { ...m, sub: m.sub === which ? null : which }), []);
  const onContextMenu = useCallback((target: T) => (e: RMouseEvent) => { e.preventDefault(); e.stopPropagation(); open(target, e.clientX, e.clientY); }, [open]);
  return { menu, open, close, toggleSub, onContextMenu, setMenu };
}

/** A card's long-press (phone) that opens the menu; the desktop right-click is `onContextMenu`. */
export function useCardPress<T>(target: T, open: (t: T, x: number, y: number) => void) {
  return useLongPress({ onPress: (x, y) => open(target, x, y) });
}

/**
 * The menu itself, rendered once per surface. `items` may be a function, so
 * a surface whose verbs touch refs (the canvas, whose board lives in one)
 * builds them only when the menu is open.
 */
export function ContextMenuHost({ title, menu, items, onClose }: { title: ReactNode; menu: { x: number; y: number } | null; items: MenuItem[] | (() => MenuItem[]); onClose: () => void }) {
  if (!menu) return null;
  return <Menu x={menu.x} y={menu.y} title={title} items={typeof items === "function" ? items() : items} onClose={onClose} />;
}

/**
 * Keyboard equivalents while a card is selected: ⌘X ⌘C ⌘V ⌘D, ↵ rename,
 * ⌘R open in Rig, ⌫ delete. Nothing fires while typing in a field.
 */
export function useCardKeys(enabled: boolean, a: ContextActions): void {
  useEffect(() => {
    if (!enabled) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const run = (fn?: (() => void) | null) => { if (fn) { e.preventDefault(); fn(); } };
      if (mod && k === "x") run(a.cut);
      else if (mod && k === "c") run(a.copy);
      else if (mod && k === "v") run(a.paste);
      else if (mod && k === "d") run(a.duplicate);
      else if (mod && k === "r") run(a.openInRig);
      else if (!mod && e.key === "Enter") run(a.rename);
      else if (!mod && (e.key === "Backspace" || e.key === "Delete")) run(a.remove);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
}
