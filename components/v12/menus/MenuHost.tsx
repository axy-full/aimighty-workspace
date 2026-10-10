"use client";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { runBoardCommand, type BoardMenuCommand } from "@/lib/board/commands";
import { SAY } from "@/lib/shell/assets";
import { isLanded } from "@/lib/shell/screens";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { assetIdFromUrl } from "@/lib/preview";
import { chordOf, typingIn } from "@/lib/v12/keymap";
import { menuFor, type MenuAction, type MenuKind } from "@/lib/v12/menus";
import { requestTrayToggle } from "@/lib/v12/useLibraryTray";
import { ContextMenu, useOverlayStack, useToast, type MenuItem } from "../ui";
import { downloadOriginal, menuItems, useMenuAt } from "./menu-items";

/**
 * The new frame's right-click menus and card keys where the screen is still today's (redesign A3): a board's cards and
 * canvas, and empty space. Screens rebuilt for the new frame draw their own (Home's wall and boards, the Library tray,
 * Make's results) and stop the event there; a header tab has the tab menu (components/v12/shell/Header.tsx).
 *
 * Mounted only in the new frame (components/v12/V12Shell.tsx), so with the switch off nothing here runs. The board's
 * actions go through its command bus (lib/board/commands.ts), which runs the code its keys and clicks run; a card's
 * Approve presses the card's own Approve (free, with Undo: components/graphite/board/cards/take/use-judge.ts). A file
 * tile of today's screens (`data-ctx`) and a Rig node keep today's right-click menu.
 *
 * Keys (lib/v12/keymap.ts): A approves the selected card or cards (plan decision 3), ⌘A selects every card on a
 * board. Never while typing, never behind a menu, sheet, dialog or the viewer.
 */

type Target =
  | { kind: "card"; id: string; node: HTMLElement }
  | { kind: "multi"; ids: string[] }
  | { kind: "canvas" }
  | { kind: "empty" };

const NODE = ".bd-node[data-card-id]";
const selectedNodes = () => Array.from(document.querySelectorAll<HTMLElement>(`${NODE}[data-selected]`));
const nodeOf = (id: string) => document.querySelector<HTMLElement>(`${NODE}[data-card-id="${CSS.escape(id)}"]`);

/**
 * A card's own Approve, when it has one that can be pressed now. For a take card that is the one selected card, the
 * Inspector's too (the Inspector shows the selected take): never for a card that is not selected yet, whose Inspector
 * still shows the card before it.
 */
function approveButton(node: HTMLElement | null, alone: boolean): HTMLButtonElement | null {
  const own = node?.querySelector<HTMLButtonElement>('[data-testid="take-approve"]:not([disabled])') ?? null;
  if (own || !alone || !node || node.dataset.cardKind !== "take" || node.dataset.selected !== "true" || selectedNodes().length !== 1) return own;
  return document.querySelector<HTMLButtonElement>('[data-testid="insp-approve"]:not([disabled])');
}

/** The file a card shows (its current take), from the preview attributes every asset surface carries (lib/preview.ts). */
function cardFile(node: HTMLElement | null): { url: string; asset: string; kind: string; name: string } | null {
  const el = node?.querySelector<HTMLElement>("[data-preview-url]");
  const url = el?.dataset.previewUrl;
  const asset = el?.dataset.previewAsset ?? assetIdFromUrl(url);
  if (!el || !url || !asset) return null;
  return { url, asset, kind: el.dataset.previewKind ?? "", name: el.dataset.previewName || "This take" };
}

/** Something modal is over the page: a menu, a sheet or dialog, the viewer. Keys and menus of the page wait. */
function blocked(top: string | null): boolean {
  if (top && top !== "selection" && top !== "drawer" && top !== "tool") return true;
  return Boolean(document.querySelector(".gx-veil, [aria-modal='true'], .pv-veil"));
}

export function MenuHost({ children }: { children: ReactNode }) {
  const shell = useShell();
  const toast = useToast();
  const stack = useOverlayStack();
  const menu = useMenuAt<Target>();

  const board = (command: BoardMenuCommand | { name: "tidy" | "fit" }) => {
    if (!runBoardCommand(command)) toast({ text: "The board cannot do that right now." });
  };
  const approve = (ids: readonly string[]) => {
    const buttons = ids.map((id) => approveButton(nodeOf(id), ids.length === 1)).filter((b): b is HTMLButtonElement => Boolean(b));
    if (!buttons.length) { toast({ text: ids.length === 1 ? "This card has nothing to approve." : "These cards have nothing to approve." }); return; }
    for (const button of buttons) button.click();
  };
  const askAtomik = () => { if (!isLanded("atomik")) shell.goSuite("atomik"); else shell.openAtomik(); };

  const onContextMenu = (event: MouseEvent) => {
    const el = event.target as HTMLElement;
    if (!(el instanceof Element)) return;
    /* A menu, tooltip or toast of the new frame: no menu on a menu, and not the browser's either. */
    if (el.closest(".v12-portal")) { event.preventDefault(); return; }
    /* A field keeps the browser's menu (paste, spelling); a file tile or Rig node of today's screens keeps today's menu. */
    if (typingIn(el) || el.closest("[data-ctx]")) return;
    const node = el.closest<HTMLElement>(NODE);
    if (node) {
      const id = node.dataset.cardId!;
      const selected = selectedNodes().map((n) => n.dataset.cardId!);
      if (selected.length > 1 && selected.includes(id)) { menu.open(event, { kind: "multi", ids: selected }); return; }
      /* A right-click selects the card it is on, as the prototype's does: its Inspector shows what the menu acts on. */
      if (!selected.includes(id) || selected.length !== 1) runBoardCommand({ name: "select", card: id });
      menu.open(event, { kind: "card", id, node });
      return;
    }
    if (el.closest(".bd-flow") && !el.closest(".react-flow__panel, button, a, [role='button']")) { menu.open(event, { kind: "canvas" }); return; }
    /* Today's controls keep their own menus; elsewhere, the frame's. */
    if (el.closest("button, a, [role='button'], [role='menuitem']")) return;
    menu.open(event, { kind: "empty" });
  };

  /* A ⌘A selects every card; A approves the selected card or cards. */
  const live = useRef({ approve, board });
  useEffect(() => { live.current = { approve, board }; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || typingIn(event.target)) return;
      const chord = chordOf(event);
      if (chord !== "A" && chord !== "⌘A") return;
      if (blocked(stack?.top()?.layer ?? null) || !document.querySelector(".bd-flow")) return;
      if (chord === "⌘A") { event.preventDefault(); live.current.board({ name: "select-all" }); return; }
      const ids = selectedNodes().map((n) => n.dataset.cardId!);
      if (!ids.length) return;
      event.preventDefault();
      live.current.approve(ids);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stack]);

  const target = menu.menu?.target ?? null;
  let kind: MenuKind = "empty";
  const can = new Set<MenuAction>();
  let label = "Menu";
  let run: (id: MenuAction) => void = () => {};
  if (target?.kind === "card") {
    kind = "card";
    const file = cardFile(target.node);
    const free = target.node.dataset.free === "true" || target.node.dataset.cardKind === "take";
    label = file?.name ?? "Card";
    can.add("open");
    if (file) can.add("download");
    if (file && (file.kind === "image" || file.kind === "video")) can.add("use-as-reference");
    if (approveButton(target.node, true)) can.add("approve");
    if (free) can.add("delete");
    run = (id) => {
      switch (id) {
        case "open": board({ name: "select", card: target.id }); return;
        case "download": if (file) downloadOriginal(file.url); return;
        case "use-as-reference":
          if (!file) return;
          sendReference({ id: file.asset, name: file.name });
          shell.openMake();
          toast({ text: SAY.referenced(file.name, file.kind === "video" ? "Video" : "Image") });
          return;
        case "approve": approve([target.id]); return;
        case "delete": board({ name: "remove" }); return;
      }
    };
  } else if (target?.kind === "multi") {
    kind = "multi";
    label = `${target.ids.length} cards`;
    if (target.ids.some((id) => approveButton(nodeOf(id), false))) can.add("approve-all");
    if (target.ids.some((id) => { const n = nodeOf(id); return n?.dataset.free === "true" || n?.dataset.cardKind === "take"; })) can.add("delete-all");
    run = (id) => { if (id === "approve-all") approve(target.ids); else if (id === "delete-all") board({ name: "remove" }); };
  } else if (target?.kind === "canvas") {
    kind = "canvas";
    label = "Board";
    for (const id of ["new", "new-note", "new-text", "new-image", "new-video", "new-audio", "upload", "ask-atomik", "select-all", "tidy", "fit"] as const) can.add(id);
    if (shell.clip && shell.runCommand) can.add("paste");
    const tools: Partial<Record<MenuAction, "note" | "text" | "image" | "video" | "audio" | "upload">> = { "new-note": "note", "new-text": "text", "new-image": "image", "new-video": "video", "new-audio": "audio", upload: "upload" };
    run = (id) => {
      const tool = tools[id];
      if (tool) { board({ name: "tool", tool }); return; }
      switch (id) {
        case "paste": shell.runCommand?.("paste", { kind: "empty" }); return;
        case "ask-atomik": askAtomik(); return;
        case "select-all": board({ name: "select-all" }); return;
        case "tidy": board({ name: "tidy" }); return;
        case "fit": board({ name: "fit" }); return;
      }
    };
  } else if (target?.kind === "empty") {
    label = "Particl";
    for (const id of ["library", "make", "ask-atomik", "palette"] as const) can.add(id);
    run = (id) => {
      switch (id) {
        case "library": requestTrayToggle(); return;
        case "make": shell.openMake(); return;
        case "ask-atomik": askAtomik(); return;
        case "palette": shell.setPalette(true); return;
      }
    };
  }
  const items: MenuItem[] = target ? menuItems(menuFor(kind, can), run) : [];

  return (
    <div className="v12 v12-frame" data-testid="v12-root" onContextMenu={onContextMenu}>
      {children}
      {menu.menu && items.length ? (
        <ContextMenu at={menu.menu.at} onClose={menu.close} label={label} items={items} width={kind === "canvas" || kind === "empty" ? 240 : 260}
          testId={kind === "card" ? "v12-card-menu" : kind === "multi" ? "v12-multi-menu" : kind === "canvas" ? "v12-canvas-menu" : "v12-empty-menu"} />
      ) : null}
    </div>
  );
}
