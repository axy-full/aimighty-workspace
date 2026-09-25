/**
 * The right-click menu, as data (README › Right-click menu). Pure: what the
 * target is, which items it gets, which are blocked and why, and where the
 * menu sits. The component only draws this.
 */
export type CtxTarget =
  | { kind: "asset"; id: string }
  | { kind: "node"; id: string }
  | { kind: "empty" };

/** `asset:abc` / `node:n1` from the nearest `[data-ctx]`; anything else is empty space. */
export function parseCtx(value: string | null | undefined): CtxTarget {
  if (!value) return { kind: "empty" };
  const i = value.indexOf(":");
  const kind = i < 0 ? "" : value.slice(0, i);
  const id = i < 0 ? "" : value.slice(i + 1);
  if ((kind === "asset" || kind === "node") && id) return { kind, id };
  return { kind: "empty" };
}

export type CtxCommand =
  | "copy" | "cut" | "paste" | "duplicate"
  | "use-as-reference" | "open-in-inspector"
  | "bypass" | "unplug"
  | "move" | "retry" | "delete" | "undo"
  | "generate-here" | "open-library" | "toggle-inspector";

export type CtxItem =
  | { sep: true }
  | { sep?: false; command: CtxCommand; label: string; key?: string; danger?: boolean; disabled?: boolean; reason?: string };

export type CtxCapabilities = {
  /** Commands this build can carry out for this target; the rest are shown, blocked, with the reason. */
  can: Partial<Record<CtxCommand, true>>;
  /** Why a command that is not in `can` is blocked. */
  why: Partial<Record<CtxCommand, string>>;
  hasClipboard: boolean;
  canUndo: boolean;
};

const item = (command: CtxCommand, label: string, key?: string, danger?: boolean): CtxItem => ({ command, label, key, danger });

/** Commands every target keeps in its menu: they act on the clipboard or the history, not on the node. */
const SHARED: CtxCommand[] = ["paste", "undo"];

/** Drop leading, trailing and doubled separators left behind when items are omitted. */
function tidy(items: CtxItem[]): CtxItem[] {
  return items.filter((entry, i, all) => !entry.sep || (i > 0 && i < all.length - 1 && !all[i - 1].sep));
}

/**
 * The README's order, verbatim. A Rig node lists only what the Rig carries
 * out for it (plus Paste and Undo); a command it cannot do is left out
 * rather than shown greyed with a generic reason, unless the capabilities
 * give it a reason of its own.
 */
export function ctxItems(target: CtxTarget, caps: CtxCapabilities): CtxItem[] {
  const list: CtxItem[] = [
    item("copy", "Copy", "⌘C"), item("cut", "Cut", "⌘X"), item("paste", "Paste", "⌘V"), item("duplicate", "Duplicate", "⌘D"),
    { sep: true },
  ];
  if (target.kind === "asset") list.push(item("use-as-reference", "Use as reference"), item("open-in-inspector", "Open in Inspector"));
  if (target.kind === "node") list.push(item("bypass", "Bypass"), item("unplug", "Unplug all inputs"));
  list.push(item("move", "Move to…"), item("retry", "Retry", "⌘R"), { sep: true }, item("delete", "Delete", "⌫", true), item("undo", "Undo", "⌘Z"));
  if (target.kind === "empty") list.push({ sep: true }, item("generate-here", "Generate here…"), item("open-library", "Open Library"), item("toggle-inspector", "Toggle Inspector", "⌘J"));
  const ALWAYS: CtxCommand[] = ["generate-here", "open-library", "toggle-inspector"];
  const offered = target.kind === "node"
    ? tidy(list.filter((entry) => entry.sep || SHARED.includes(entry.command) || caps.can[entry.command] || caps.why[entry.command]))
    : list;
  return offered.map((entry) => {
    if (entry.sep) return entry;
    if (ALWAYS.includes(entry.command)) return entry;
    if (entry.command === "undo") return caps.canUndo ? entry : { ...entry, disabled: true, reason: "Nothing to undo." };
    if (entry.command === "paste" && !caps.hasClipboard) return { ...entry, disabled: true, reason: "Nothing copied yet." };
    if (target.kind === "empty") return { ...entry, disabled: true, reason: "Select an asset or a node first." };
    if (caps.can[entry.command]) return entry;
    return { ...entry, disabled: true, reason: caps.why[entry.command] ?? "Not available for this selection." };
  });
}

/** At the cursor, flipped when it would leave the viewport and clamped to an 8px margin. */
export function placeMenu(cursor: { x: number; y: number }, menu: { width: number; height: number }, viewport: { width: number; height: number }, margin = 8) {
  let left = cursor.x;
  let top = cursor.y;
  if (left + menu.width + margin > viewport.width) left = cursor.x - menu.width;
  if (top + menu.height + margin > viewport.height) top = cursor.y - menu.height;
  left = Math.max(margin, Math.min(left, viewport.width - menu.width - margin));
  top = Math.max(margin, Math.min(top, viewport.height - menu.height - margin));
  return { left, top };
}

/** ⌘C/X/V/D/Z/R and ⌫ on the selection, when focus is not in a field. */
export function shortcutCommand(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; altKey?: boolean }): CtxCommand | null {
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (!mod) return key === "backspace" || key === "delete" ? "delete" : null;
  if (event.shiftKey) return null;
  switch (key) {
    case "c": return "copy";
    case "x": return "cut";
    case "v": return "paste";
    case "d": return "duplicate";
    case "z": return "undo";
    case "r": return "retry";
    default: return null;
  }
}

/**
 * Where a selection shortcut may act on the lingering selection. The browser
 * keeps its own ⌘C/⌘X while text is selected; ⌫ and ⌘R act only from inside
 * a surface that shows the selection (the Library, the Inspector, an asset
 * grid, the Rig) — never from another button, and ⌘R never from the page
 * itself, where it means reload.
 */
const SELECTION_SURFACE = "[data-ctx], [data-testid='library'], [data-testid='inspector'], [data-testid='rig-graph'], [data-testid='rig-list']";
export function shortcutApplies(cmd: CtxCommand, context: { target: EventTarget | null; textSelected: boolean; selection: CtxTarget["kind"] }): boolean {
  if ((cmd === "copy" || cmd === "cut") && context.textSelected) return false;
  if (cmd !== "delete" && cmd !== "retry") return true;
  const el = context.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest(SELECTION_SURFACE)) return true;
  /* A Rig node is picked on the canvas, which takes no focus: ⌫ on the page itself still deletes it. An asset is picked by a button, so its ⌫ comes from where it is shown. */
  return cmd === "delete" && context.selection === "node" && (el.tagName === "BODY" || el.tagName === "HTML");
}

/** True when the event started in something a person types into. */
export function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}
