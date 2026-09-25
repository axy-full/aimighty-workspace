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

/** What a Rig shot's menu always shows; its other commands appear only once the Rig can carry them out. */
const NODE_ALWAYS: readonly CtxCommand[] = ["delete", "undo"];

/** Drop separators left leading, trailing or doubled once items are filtered out. */
function tidy(list: CtxItem[]): CtxItem[] {
  const out: CtxItem[] = [];
  for (const entry of list) if (!entry.sep || (out.length && !out[out.length - 1].sep)) out.push(entry);
  if (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

/** The README's order, verbatim. */
export function ctxItems(target: CtxTarget, caps: CtxCapabilities): CtxItem[] {
  let list: CtxItem[] = [
    item("copy", "Copy", "⌘C"), item("cut", "Cut", "⌘X"), item("paste", "Paste", "⌘V"), item("duplicate", "Duplicate", "⌘D"),
    { sep: true },
  ];
  if (target.kind === "asset") list.push(item("use-as-reference", "Use as reference"), item("open-in-inspector", "Open in Inspector"));
  if (target.kind === "node") list.push(item("bypass", "Bypass"), item("unplug", "Unplug all inputs"));
  list.push(item("move", "Move to…"), item("retry", "Retry", "⌘R"), { sep: true }, item("delete", "Delete", "⌫", true), item("undo", "Undo", "⌘Z"));
  if (target.kind === "empty") list.push({ sep: true }, item("generate-here", "Generate here…"), item("open-library", "Open Library"), item("toggle-inspector", "Toggle Inspector", "⌘J"));
  /* A Rig shot never lists a command that is always greyed out: only what the Rig has registered, plus Delete and Undo. */
  if (target.kind === "node") list = tidy(list.filter((entry) => entry.sep || NODE_ALWAYS.includes(entry.command) || caps.can[entry.command]));
  const ALWAYS: CtxCommand[] = ["generate-here", "open-library", "toggle-inspector"];
  return list.map((entry) => {
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

/** True when the event started in something a person types into. */
export function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}
