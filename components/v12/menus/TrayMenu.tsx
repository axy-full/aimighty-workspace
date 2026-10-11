"use client";
import { openPreview } from "@/components/PreviewLayer";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { previewKindOf } from "@/lib/preview";
import { SAY, assetCapabilities, assetRef, referenceRole } from "@/lib/shell/assets";
import type { RecipeSource } from "@/lib/shell/recipe";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useRecreatePrice } from "@/lib/shell/use-recreate-price";
import { useSession } from "@/lib/session";
import type { TrayItem } from "@/lib/v12/library";
import { menuFor, type MenuAction } from "@/lib/v12/menus";
import { recreateQuote } from "@/lib/v12/recreateQuote";
import type { LibraryEntry } from "@/lib/workspace/library";
import { ContextMenu, useToast } from "../ui";
import { Price } from "../ui/Price";
import { downloadOriginal, menuItems, type MenuAt } from "./menu-items";

/**
 * The right-click menu on a Library tray tile (redesign A3; inventory § 5.11 card). Open, Download original and Use as
 * reference work for any library browsed. The rest run today's Library commands (the shell's runCommand, which the old
 * right-click menu, ⌘C, ⌘R and ⌫ also run: lib/shell/use-asset-actions.ts), so only for a file of the open board's own
 * Library: Copy, Move to board… (today's move picker), Redraw (Make opens with the take's recipe; the price is Make's own
 * for it, read while the menu is open, and nothing is spent until Make is pressed), and Delete (with Undo).
 */
export function TrayMenu({ menu, onClose, shown, own, otherBoards, aspect }: {
  menu: MenuAt<string> | null;
  onClose: () => void;
  /** The tiles on show, for Open to walk. */
  shown: readonly TrayItem[];
  /** The open board's own Library, as the shell's commands read it; null when another board's library is browsed. */
  own: readonly LibraryEntry[] | null;
  otherBoards: number;
  aspect?: string;
}) {
  const shell = useShell();
  const session = useSession();
  const toast = useToast();
  const spendOff = useSampleWorkspace();
  const item = menu ? shown.find((t) => t.id === menu.target) ?? null : null;
  /* Today's commands act on the open board's Library: a file they cannot find there gets only what needs no board. */
  const mine = item && own ? own.find((e) => e.take.id === item.id) ?? null : null;
  const caps = mine ? assetCapabilities({ asset: assetRef(mine), clip: null, projectId: "open", otherProjects: otherBoards, canUndo: false }) : null;
  const redrawable = mine && caps?.can.retry && !spendOff ? mine : null;
  const price = useRecreatePrice(session.requestScope ?? "", redrawable?.take.id ?? null, redrawable ? (redrawable.asset.value as RecipeSource) : null, aspect);
  if (!menu || !item) return null;

  const role = referenceRole(item.media);
  const can = new Set<MenuAction>(["open"]);
  if (item.url) can.add("download");
  if (role && item.url) can.add("use-as-reference");
  if (mine && caps && shell.runCommand) {
    can.add("copy");
    if (caps.can.move) can.add("move");
    if (redrawable) can.add("redraw");
    can.add("delete");
  }

  const run = (id: MenuAction) => {
    const target = { kind: "asset" as const, id: item.id };
    switch (id) {
      case "open": {
        const list = shown.filter((t) => t.url);
        const items = list.map((t) => ({ url: t.url!, kind: previewKindOf(t.media), name: t.name, asset: t.id }));
        openPreview(items, Math.max(0, list.indexOf(item)));
        return;
      }
      case "download": if (item.url) downloadOriginal(item.url); return;
      case "use-as-reference":
        if (!role) return;
        sendReference({ id: item.id, name: item.name });
        shell.openMake();
        toast({ text: SAY.referenced(item.name, role) });
        return;
      case "copy": shell.runCommand?.("copy", target); return;
      case "move": shell.runCommand?.("move", target); return;
      case "redraw": shell.runCommand?.("retry", target); return;
      case "delete": shell.runCommand?.("delete", target); return;
    }
  };
  const items = menuItems(menuFor("card", can), run, { redraw: <Price quote={recreateQuote(price, session.rates.unit === "usd")} testId="v12-menu-price" /> });
  return <ContextMenu at={menu.at} onClose={onClose} label={item.name} items={items} testId="v12-card-menu" />;
}
