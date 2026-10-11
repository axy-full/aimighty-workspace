"use client";
import { openPreview } from "@/components/PreviewLayer";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { SAY, referenceRole } from "@/lib/shell/assets";
import type { RecipeSource } from "@/lib/shell/recipe";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useRecreatePrice } from "@/lib/shell/use-recreate-price";
import { useSession } from "@/lib/session";
import type { WallTile } from "@/lib/v12/home";
import { menuFor, type MenuAction } from "@/lib/v12/menus";
import { recreateQuote } from "@/lib/v12/recreateQuote";
import { ContextMenu, useToast } from "../ui";
import { Price } from "../ui/Price";
import { downloadOriginal, menuItems, type MenuAt } from "./menu-items";

/**
 * The right-click menu on a still or clip of Home's wall (redesign A3; inventory § 5.11 card, with the wall's own two
 * actions from § 5.9). Every item is an action the wall already has or today's Library has:
 *  - Open: the site's previewer, walking the wall.
 *  - Make one like this: picks the tile, as a click does.
 *  - Download original: the stored file (/api/media/…?download=1).
 *  - Use as reference: Make opens with it in its references (today's reference letterbox).
 *  - Remix this: Make opens with the take's recipe, as the tile's button does. Its price is Make's own for that recipe,
 *    read from the server's quote while the menu is open (lib/shell/use-recreate-price.ts); nothing is spent until Make
 *    is pressed, behind today's approval. Not offered in the sample workspace, which spends nothing.
 */
export function WallMenu({ scope, tiles, menu, onClose, onChoose, onRemix }: {
  scope: string;
  tiles: readonly WallTile[];
  menu: MenuAt<string> | null;
  onClose: () => void;
  onChoose: (tile: WallTile) => void;
  onRemix: (tile: WallTile) => void;
}) {
  const session = useSession();
  const shell = useShell();
  const toast = useToast();
  const spendOff = useSampleWorkspace();
  const tile = menu ? tiles.find((t) => t.id === menu.target) ?? null : null;
  const remixable = tile && !spendOff && !tile.remixBlock ? tile : null;
  const price = useRecreatePrice(session.requestScope ?? scope, remixable?.id ?? null, remixable ? (remixable.source as RecipeSource) : null);
  if (!menu || !tile) return null;

  const role = referenceRole(tile.media);
  const can = new Set<MenuAction>(["open", "make-like", "download"]);
  if (role) can.add("use-as-reference");
  if (remixable) can.add("remix");

  const run = (id: MenuAction) => {
    switch (id) {
      case "open": {
        const items = tiles.map((t) => ({ url: t.url, kind: t.media, name: t.title, asset: `generation:${t.id}` }));
        openPreview(items, Math.max(0, tiles.indexOf(tile)));
        return;
      }
      case "make-like": onChoose(tile); return;
      case "download": downloadOriginal(tile.url); return;
      case "use-as-reference":
        if (!role) return;
        sendReference({ id: `generation:${tile.id}`, name: tile.title });
        shell.openMake();
        toast({ text: SAY.referenced(tile.title, role) });
        return;
      case "remix": onRemix(tile); return;
    }
  };
  const items = menuItems(menuFor("card", can), run, { remix: <Price quote={recreateQuote(price, session.rates.unit === "usd")} testId="v12-menu-price" /> });
  return <ContextMenu at={menu.at} onClose={onClose} label={tile.title} items={items} testId="v12-card-menu" />;
}
