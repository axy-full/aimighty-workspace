/**
 * The new interface's right-click menus, as data (redesign A3; docs/redesign/inventory.md § 5.11). Pure: which items a
 * target gets, in the prototype's order and words, with their keys from the keyboard map (lib/v12/keymap.ts). The
 * component (components/v12/menus/) only draws this and runs each item's existing action.
 *
 * An item is listed only when its action exists today for that target (`can`): a menu never shows a command that does
 * nothing. What the prototype lists and the app cannot do yet is kept below in NOT_BUILT, with why, for the report.
 *
 * Items that spend are marked `priced`: the menu draws their price from the quote layer (<Price>), never a figure here.
 * None of them spends from the menu: each opens Make with the take's recipe, and Make asks before anything is spent.
 */
import { keyOf } from "./keymap";

export type MenuKind =
  /** One card: a take on a board, a file in the Library, a still or clip on Home's wall, a result in Make. */
  | "card"
  /** Several selected cards (right-click inside the selection). */
  | "multi"
  /** A board's empty canvas. */
  | "canvas"
  /** Empty space anywhere else in the new frame. */
  | "empty"
  /** A board's card on Home (Your boards). */
  | "board"
  /** Empty space on Make's results (V10·13: Paste · Upload… · Select all, less what is not built). */
  | "make-empty";

export type MenuAction =
  | "open" | "make-like" | "download" | "copy" | "use-as-reference" | "move" | "redraw" | "remix" | "load-prompt"
  | "approve" | "delete" | "copy-link"
  | "approve-all" | "delete-all"
  | "paste" | "new" | "new-note" | "new-text" | "new-image" | "new-video" | "new-audio" | "upload" | "ask-atomik"
  | "select-all" | "tidy" | "fit"
  | "library" | "make" | "palette"
  | "select-results" | "clear-selection";

export type MenuEntry =
  | { sep: true; id: string }
  | { sep?: false; id: MenuAction; label: string; key?: string; priced?: true; danger?: true; sub?: readonly MenuEntry[] };

const item = (id: MenuAction, label: string, extra: { key?: string; priced?: true; danger?: true; sub?: readonly MenuEntry[] } = {}): MenuEntry => ({ id, label, ...extra });
const sep = (id: string): MenuEntry => ({ sep: true, id });

/** Card, single (inventory § 5.11, prototype L839), less what is not built; "Make one like this" and "Remix this" are
 *  the wall's own two actions (§ 5.9), "Load prompt" Make's (§ 5.12). */
const CARD: readonly MenuEntry[] = [
  item("open", "Open"),
  item("make-like", "Make one like this"),
  item("load-prompt", "Load prompt"),
  item("download", "Download original"),
  sep("s1"),
  item("copy", "Copy", { key: keyOf("copy") }),
  sep("s2"),
  item("use-as-reference", "Use as reference"),
  item("move", "Move to board…"),
  sep("s3"),
  item("redraw", "Redraw", { priced: true }),
  item("remix", "Remix this", { priced: true }),
  sep("s4"),
  item("approve", "Approve", { key: keyOf("approve") }),
  sep("s5"),
  item("delete", "Delete", { key: keyOf("delete"), danger: true }),
];

/** Card, multi: the prototype's "Approve all A" and "Delete ⌫" (the rest is in NOT_BUILT). */
const MULTI: readonly MenuEntry[] = [
  item("approve-all", "Approve all", { key: keyOf("approve") }),
  sep("s1"),
  item("delete-all", "Delete", { key: keyOf("delete"), danger: true }),
];

/** New ▸ on the canvas: the board's own tools (prototype right toolbar), each with its key. */
const NEW: readonly MenuEntry[] = [
  item("new-note", "Note", { key: keyOf("tool-note") }),
  item("new-text", "Text", { key: keyOf("tool-text") }),
  item("new-image", "Image", { key: keyOf("tool-image") }),
  item("new-video", "Video", { key: keyOf("tool-video") }),
  item("new-audio", "Audio", { key: keyOf("tool-audio") }),
];

/** Canvas (inventory § 5.11, prototype L840). "Ask Atomik here" reads "Ask Atomik": the panel opens, but nothing yet
 *  lands where the click was. "Tidy" has no key: T is Text. */
const CANVAS: readonly MenuEntry[] = [
  item("paste", "Paste", { key: keyOf("paste") }),
  sep("s1"),
  item("new", "New", { sub: NEW }),
  item("upload", "Upload…", { key: keyOf("upload") }),
  sep("s2"),
  item("ask-atomik", "Ask Atomik", { key: keyOf("atomik-panel") }),
  sep("s3"),
  item("select-all", "Select all", { key: keyOf("select-all") }),
  item("tidy", "Tidy"),
  item("fit", "Zoom to fit", { key: keyOf("fit") }),
];

/** Empty space off a board: where to go from here, each with its key. */
const EMPTY: readonly MenuEntry[] = [
  item("library", "Library", { key: keyOf("library") }),
  item("make", "Make", { key: keyOf("make") }),
  sep("s1"),
  item("ask-atomik", "Atomik panel", { key: keyOf("atomik-panel") }),
  item("palette", "Ask Atomik, search or go to", { key: keyOf("palette") }),
];

/** A board's card on Home: the tab menu's (§ 5.11 Tab) that apply to a board that is not open in a tab. */
const BOARD: readonly MenuEntry[] = [
  item("open", "Open"),
  item("copy-link", "Copy link"),
];

/** Empty space on Make's results: the selection, then where to go. */
const MAKE_EMPTY: readonly MenuEntry[] = [
  item("select-results", "Select all"),
  item("clear-selection", "Clear the selection"),
  sep("s1"),
  item("library", "Library", { key: keyOf("library") }),
  item("palette", "Ask Atomik, search or go to", { key: keyOf("palette") }),
];

const MENUS: Record<MenuKind, readonly MenuEntry[]> = { card: CARD, multi: MULTI, canvas: CANVAS, empty: EMPTY, board: BOARD, "make-empty": MAKE_EMPTY };

/** Drops leading, trailing and doubled separators left behind when items are left out. */
function tidy(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.sep && (!out.length || out[out.length - 1].sep)) continue;
    out.push(entry);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

/** The menu for a target: its kind's items that `can` holds, in order, with a submenu only when it has items. */
export function menuFor(kind: MenuKind, can: ReadonlySet<MenuAction>): MenuEntry[] {
  const keep = (entries: readonly MenuEntry[]): MenuEntry[] => tidy(entries.flatMap((entry): MenuEntry[] => {
    if (entry.sep) return [entry];
    if (!can.has(entry.id)) return [];
    if (!entry.sub) return [entry];
    const sub = keep(entry.sub);
    return sub.length ? [{ ...entry, sub }] : [];
  }));
  return keep(MENUS[kind]);
}

/** Every key a menu shows (for the keyboard map's test: a key shown is a key that works). */
export function menuKeys(): string[] {
  const out: string[] = [];
  const walk = (entries: readonly MenuEntry[]) => { for (const e of entries) if (!e.sep) { if (e.key) out.push(e.key); if (e.sub) walk(e.sub); } };
  Object.values(MENUS).forEach(walk);
  return out;
}

/**
 * What the prototype's menus list that the app has no action for yet (inventory § 5.11), left out of the menus above.
 * The report and the progress log list these; each comes back when its action exists.
 */
export const NOT_BUILT: readonly { menu: string; item: string; why: string }[] = [
  { menu: "Card", item: "Copy image", why: "No path copies a picture to the system clipboard." },
  { menu: "Card", item: "Duplicate ⌘D", why: "A take has one copy (lib/shell/assets.ts: today's ⌘D says so); Redraw makes a new take." },
  { menu: "Card", item: "Send to board ▸ (copy)", why: "A take belongs to one board; the existing action moves it (Move to board…)." },
  { menu: "Card", item: "Keep in Library as ▸", why: "No kind can be set on a Library file yet (C4: Products and Mandatories are stubs)." },
  { menu: "Card", item: "More like this", why: "No variations path: Make has no \"4 more like this\" action to open or quote." },
  { menu: "Card", item: "Upscale U", why: "The upscale tool takes a file but has no quote for it before it opens; its price is shown in the tool." },
  { menu: "Card", item: "Lock L", why: "No lock exists on a frame or take." },
  { menu: "Card", item: "Details I", why: "On today's board Open shows the details (the Inspector); I places an Image there." },
  { menu: "Multi", item: "Download all · zip ⌥D", why: "No route zips several originals." },
  { menu: "Multi", item: "Copy ⌘C", why: "Today's clipboard holds one file." },
  { menu: "Multi", item: "Group into frame G", why: "Frames are not built on today's board (its Frame tool is off)." },
  { menu: "Multi", item: "Redraw all R", why: "No path recreates several takes at once." },
  { menu: "Multi", item: "Send to board ▸", why: "Moving cards between boards is one file at a time today." },
  { menu: "Canvas", item: "Paste (an image becomes a card, text a note)", why: "Paste files the copied Library file here; pasting from the system clipboard onto the canvas is not built." },
  { menu: "Canvas", item: "Ask Atomik here", why: "Atomik's panel opens; a result does not yet land where the click was." },
  { menu: "Canvas", item: "Tidy T", why: "T is Text on the board; Tidy is listed without a key." },
  { menu: "Make result", item: "Variations", why: "No variations path in Make (as More like this)." },
  { menu: "Make result", item: "Keep in Library", why: "A Make result is already in the workspace's Library; filing it on a board is Move to board on a board's Library file." },
  { menu: "Make result", item: "Redraw", why: "In Make, Load prompt is the same action (the take's recipe into the composer), so it is listed once." },
  { menu: "Make, several results", item: "Download all, Delete", why: "No zip route, and Make's results have no delete path of their own yet; right-click on a selected result shows its own menu." },
  { menu: "Make, empty space", item: "Paste, Upload…", why: "No paste onto Make; uploads go through the composer's + (Attach)." },
];
