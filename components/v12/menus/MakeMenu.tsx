"use client";
import type { ResultTile } from "@/lib/v12/make";
import { menuFor, type MenuAction } from "@/lib/v12/menus";
import { requestTrayToggle } from "@/lib/v12/useLibraryTray";
import { useShell } from "@/lib/shell/state";
import { ContextMenu } from "../ui";
import { downloadOriginal, menuItems, type MenuAt } from "./menu-items";

/**
 * Make's right-click menus (redesign A3; inventory § 5.11 "Make result", V10·13): on a result, the card menu less
 * Approve and Lock, with Load prompt; on empty space, the selection and where to go. Every item is an action Make
 * already has: the viewer, prompt reuse (the take's words and settings into the composer, which prices them on Make),
 * the original's download, use as a reference, selecting. Nothing here spends.
 */
export function MakeMenu({ menu, onClose, tiles, selected, onOpen, onReuse, onReference, onSelectAll, onClear }: {
  menu: MenuAt<string | null> | null;
  onClose: () => void;
  tiles: readonly ResultTile[];
  selected: ReadonlySet<string>;
  onOpen: (tile: ResultTile) => void;
  onReuse: (tile: ResultTile) => void;
  onReference: (tile: ResultTile) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const shell = useShell();
  if (!menu) return null;
  const tile = menu.target ? tiles.find((t) => t.id === menu.target) ?? null : null;
  if (menu.target && !tile) return null;

  if (!tile) {
    const can = new Set<MenuAction>(["library", "palette"]);
    if (tiles.some((t) => t.url && !selected.has(t.id))) can.add("select-results");
    if (selected.size) can.add("clear-selection");
    const run = (id: MenuAction) => {
      if (id === "select-results") onSelectAll();
      else if (id === "clear-selection") onClear();
      else if (id === "library") requestTrayToggle();
      else if (id === "palette") shell.setPalette(true);
    };
    return <ContextMenu at={menu.at} onClose={onClose} label="Make" items={menuItems(menuFor("make-empty", can), run)} width={240} testId="v12-make-empty-menu" />;
  }

  const done = tile.source.status === "succeeded" && Boolean(tile.url);
  const can = new Set<MenuAction>();
  if (done) can.add("open");
  if (!tile.reuseBlock) can.add("load-prompt");
  if (done) can.add("download");
  if (done && (tile.kind === "image" || tile.kind === "video")) can.add("use-as-reference");
  const run = (id: MenuAction) => {
    switch (id) {
      case "open": onOpen(tile); return;
      case "load-prompt": onReuse(tile); return;
      case "download": if (tile.url) downloadOriginal(tile.url); return;
      case "use-as-reference": onReference(tile); return;
    }
  };
  const items = menuItems(menuFor("card", can), run);
  return items.length ? <ContextMenu at={menu.at} onClose={onClose} label={tile.prompt || tile.type} items={items} testId="v12-card-menu" /> : null;
}
