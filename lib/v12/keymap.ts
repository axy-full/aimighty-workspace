/**
 * The new interface's keyboard map (redesign A3; docs/redesign/inventory.md § 4.2; plan decision 3: `A` approves the
 * selected card and ⌘J toggles Atomik's panel). One list of every key the new frame answers, where it works and what
 * it does. It is published where the prototype publishes keys: beside each menu item and in each tooltip, and both read
 * their keys from here (`keyOf`), so a key shown is a key that works. tests/unit/v12-keymap.spec.ts fails when two keys
 * clash, and when components/v12 shows a key this list does not have.
 *
 * Who answers each key (one handler per key; this list does not dispatch):
 *  - the header (components/v12/shell/Header.tsx, headerKey in shell/tabs.ts): ⌘1 ⌘2 ⌘3…⌘9, ⌘J, G then H;
 *  - the Library tray (components/v12/library/LibraryTray.tsx): L;
 *  - the menus and card keys of the new frame (components/v12/menus/MenuHost.tsx): A, ⌘A on a board;
 *  - today's shell (components/graphite/SuitesShell.tsx): ⌘K, ⌥M, ⌘Z, and ⌘C ⌘X ⌘V ⌘R ⌫ on the selected file;
 *  - today's board (components/graphite/board/BoardView.tsx): V N T I ⇧V ⇧A U, 0 and ⌘0, ⌫, Esc;
 *  - the previewer (components/PreviewLayer.tsx): ← →, Esc;
 *  - the overlay stack (components/v12/ui/overlay.tsx): Esc, top-most layer first (inventory § 4.1);
 *  - a menu (components/v12/ui/Popover.tsx): ↑ ↓ Home End Enter, → into a submenu and ← out of it.
 *
 * Pure: no React and no DOM.
 */

/**
 * Where a key works.
 *  - app: anywhere in the new frame, not while typing, nothing modal open.
 *  - board: a board is on screen (its canvas, not a field).
 *  - card: one or more cards are selected on a board.
 *  - file: a file in the Library is the selection (today's shell keys).
 *  - viewer, menu, field: modal places with their own keys (the previewer, an open menu, a text field). Keys there
 *    never reach the others, so they are checked only against their own place.
 */
export type KeyPlace = "app" | "board" | "card" | "file" | "viewer" | "menu" | "field";

/** Places that are on screen together and hear the same keypress: a key in two of them must mean one thing. */
const TOGETHER: readonly (readonly KeyPlace[])[] = [["app", "board", "card", "file"], ["viewer"], ["menu"], ["field"]];

export type KeyBinding = {
  /** What the key does, as an id: menus and tooltips ask for a key by it. */
  id: string;
  /** The key as people read it: "⌘K", "⇧V", "G H" (G, then H), "←". */
  keys: string;
  place: KeyPlace;
  /** Plain words, for the map and for screen readers. */
  does: string;
  /**
   * The action behind it. Two keys in places on screen together clash unless they do the same action (⌫ deletes the
   * selected cards on a board and the selected file in the Library: one action, two surfaces).
   */
  action?: string;
};

export const KEYMAP: readonly KeyBinding[] = [
  /* Anywhere */
  { id: "palette", keys: "⌘K", place: "app", does: "Ask Atomik, search or go to" },
  { id: "atomik-panel", keys: "⌘J", place: "app", does: "Open or close the Atomik panel" },
  { id: "home", keys: "⌘1", place: "app", does: "Home" },
  { id: "home-seq", keys: "G H", place: "app", does: "Home", action: "home" },
  { id: "make", keys: "⌘2", place: "app", does: "Make" },
  { id: "make-toggle", keys: "⌥M", place: "app", does: "Open or close Make", action: "make" },
  { id: "tab-3", keys: "⌘3", place: "app", does: "The first board tab" },
  { id: "tab-4", keys: "⌘4", place: "app", does: "The second board tab" },
  { id: "tab-5", keys: "⌘5", place: "app", does: "The third board tab" },
  { id: "tab-6", keys: "⌘6", place: "app", does: "The fourth board tab" },
  { id: "tab-7", keys: "⌘7", place: "app", does: "The fifth board tab" },
  { id: "tab-8", keys: "⌘8", place: "app", does: "The sixth board tab" },
  { id: "tab-9", keys: "⌘9", place: "app", does: "The seventh board tab" },
  { id: "library", keys: "L", place: "app", does: "Open or close the Library" },
  { id: "undo", keys: "⌘Z", place: "app", does: "Undo the last step" },
  { id: "close", keys: "Esc", place: "app", does: "Close the top-most menu, sheet, tool, selection or panel" },

  /* On a board */
  { id: "tool-select", keys: "V", place: "board", does: "Select, move and resize cards" },
  { id: "tool-note", keys: "N", place: "board", does: "A sticky note" },
  { id: "tool-text", keys: "T", place: "board", does: "A heading or label" },
  { id: "tool-image", keys: "I", place: "board", does: "An image, described in Make" },
  { id: "tool-video", keys: "⇧V", place: "board", does: "A video, described in Make" },
  { id: "tool-audio", keys: "⇧A", place: "board", does: "Audio, described in Make" },
  { id: "upload", keys: "U", place: "board", does: "Upload files to this board" },
  { id: "fit", keys: "0", place: "board", does: "Zoom to fit" },
  { id: "fit-mod", keys: "⌘0", place: "board", does: "Zoom to fit", action: "fit" },
  { id: "select-all", keys: "⌘A", place: "board", does: "Select every card" },

  /* A selected card */
  { id: "approve", keys: "A", place: "card", does: "Approve the selected card" },
  { id: "delete", keys: "⌫", place: "card", does: "Take the selected cards off the board, with Undo" },

  /* The selected file (today's shell) */
  { id: "copy", keys: "⌘C", place: "file", does: "Copy the selected file" },
  { id: "cut", keys: "⌘X", place: "file", does: "Cut the selected file, to move it" },
  { id: "paste", keys: "⌘V", place: "file", does: "Paste the copied file here" },
  { id: "recreate", keys: "⌘R", place: "file", does: "Open the selected take's recipe in Make" },
  { id: "delete-file", keys: "⌫", place: "file", does: "Delete the selected file, with Undo", action: "delete" },

  /* The previewer */
  { id: "viewer-prev", keys: "←", place: "viewer", does: "Previous take" },
  { id: "viewer-next", keys: "→", place: "viewer", does: "Next take" },
  { id: "viewer-close", keys: "Esc", place: "viewer", does: "Close the viewer" },

  /* A menu */
  { id: "menu-down", keys: "↓", place: "menu", does: "Next item" },
  { id: "menu-up", keys: "↑", place: "menu", does: "Previous item" },
  { id: "menu-run", keys: "↵", place: "menu", does: "Run the item" },
  { id: "menu-in", keys: "→", place: "menu", does: "Open the submenu" },
  { id: "menu-out", keys: "←", place: "menu", does: "Back to the menu" },
  { id: "menu-close", keys: "Esc", place: "menu", does: "Close the menu" },

  /* A text field (the bar) */
  { id: "send", keys: "↵", place: "field", does: "Send: Start, Make or Ask" },
  { id: "mention", keys: "@", place: "field", does: "Mention something from the library" },
];

const BY_ID = new Map(KEYMAP.map((binding) => [binding.id, binding]));

/** The key for an action id, as shown in a menu or a tooltip. Throws on an id the map does not have: a typo fails loudly. */
export function keyOf(id: string): string {
  const binding = BY_ID.get(id);
  if (!binding) throw new Error(`No key "${id}" in the keyboard map (lib/v12/keymap.ts).`);
  return binding.keys;
}

/** A sequence's keys one by one ("G H" → ["G", "H"]), each a chord as `chordOf` writes it. */
export const strokes = (keys: string): string[] => keys.split(" ").filter(Boolean);

/** What the first stroke of a sequence starts: "G" for "G H". A single key is its own start. */
const firstStroke = (keys: string) => strokes(keys)[0] ?? keys;

const together = (a: KeyPlace, b: KeyPlace) => TOGETHER.some((group) => group.includes(a) && group.includes(b));

export type Clash = { a: KeyBinding; b: KeyBinding; why: string };

/**
 * Keys that clash: the same keys, or one key that starts the other's sequence (a lone G would swallow "G H"), in places
 * on screen together, doing different actions.
 */
export function clashes(map: readonly KeyBinding[] = KEYMAP): Clash[] {
  const out: Clash[] = [];
  const actionOf = (b: KeyBinding) => b.action ?? b.id;
  for (let i = 0; i < map.length; i++) {
    for (let j = i + 1; j < map.length; j++) {
      const a = map[i], b = map[j];
      if (!together(a.place, b.place) || actionOf(a) === actionOf(b)) continue;
      if (a.keys === b.keys) out.push({ a, b, why: `${a.keys} is both "${a.does}" and "${b.does}"` });
      else if (strokes(a.keys).length !== strokes(b.keys).length && (firstStroke(a.keys) === b.keys || firstStroke(b.keys) === a.keys)) {
        out.push({ a, b, why: `${a.keys} and ${b.keys} start with the same key` });
      }
    }
  }
  return out;
}

/** A keypress as the map writes it: "⌘K" (⌘ or Ctrl), "⇧V", "⌥M", "A", "0", "⌫", "Esc". Null for a modifier alone. */
export function chordOf(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; code?: string }): string | null {
  const named: Record<string, string> = { Escape: "Esc", Backspace: "⌫", Delete: "⌫", Enter: "↵", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  /* ⌥ changes the character a letter types (⌥M is "µ" on a Mac): read the key's place instead. */
  const letter = event.altKey && event.code && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : null;
  const base = named[event.key] ?? letter ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return `${event.metaKey || event.ctrlKey ? "⌘" : ""}${event.altKey ? "⌥" : ""}${event.shiftKey && base.length === 1 && /[A-Z0-9]/.test(base) ? "⇧" : ""}${base}`;
}

/** True when a keypress started where a person types: an input, a text area, a select or editable text. */
export function typingIn(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown; isContentEditable?: boolean } | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}
