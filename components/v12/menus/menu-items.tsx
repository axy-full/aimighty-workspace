"use client";
import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import { downloadUrl } from "@/lib/preview";
import type { MenuAction, MenuEntry } from "@/lib/v12/menus";
import type { MenuItem } from "../ui";

/**
 * The pieces every right-click menu of the new interface shares (redesign A3): the model's entries (lib/v12/menus.ts)
 * as the Menu primitive's items, the menu's open state at the cursor, and Download original.
 */

/** The model's entries as menu items: each runs `run(id)`; a priced one draws `price[id]` after its label. */
export function menuItems(entries: readonly MenuEntry[], run: (id: MenuAction) => void, price: Partial<Record<MenuAction, ReactNode>> = {}): MenuItem[] {
  return entries.map((entry): MenuItem => entry.sep ? { separator: true, id: entry.id } : {
    id: entry.id,
    label: entry.label,
    shortcut: entry.key,
    tone: entry.danger ? "danger" : undefined,
    price: entry.priced ? price[entry.id] : undefined,
    submenu: entry.sub ? menuItems(entry.sub, run, price) : undefined,
    onSelect: () => run(entry.id),
    testId: `v12-menu-${entry.id}`,
  });
}

export type MenuAt<T> = { at: { x: number; y: number }; target: T };

/**
 * A right-click menu's state: `open` from an onContextMenu (the browser's own menu does not show, and the event goes
 * no further, so a menu outside does not open too), `close` from the menu.
 */
export function useMenuAt<T>() {
  const [menu, setMenu] = useState<MenuAt<T> | null>(null);
  const open = useCallback((event: MouseEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ at: { x: event.clientX, y: event.clientY }, target });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, open, close };
}

/** Download original: the stored file as an attachment (the same link as the Inspector's and the previewer's Download). */
export function downloadOriginal(url: string) {
  const link = document.createElement("a");
  link.href = downloadUrl(url);
  link.download = "";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** A board's own address (the tab menu's and a board card's Copy link). */
export const boardLink = (id: string) => `${window.location.origin}/suites?view=board&project=${encodeURIComponent(id)}`;

/** Copy link: the board's address on the clipboard, said in a toast. */
export function copyBoardLink(id: string, toast: (input: { text: string }) => void) {
  void navigator.clipboard?.writeText(boardLink(id)).then(() => toast({ text: "Link copied" }), () => toast({ text: "The link could not be copied" }));
}
