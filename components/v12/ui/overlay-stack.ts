/**
 * One overlay stack for the new interface (docs/redesign/inventory.md § 4.1). Every layer that Esc or an outside click
 * can close registers here while it is open, and Esc closes the top-most layer first:
 *
 *   viewer → join sheet → Rig expand / impact → menus, popovers and sheets → armed tool → selection → drawers / panel
 *
 * Within a layer the one opened last goes first, so a menu opened from a dialog closes before the dialog (the prototype
 * closes every menu at once; one at a time keeps a nested menu's parent open). Esc never cancels a render: a render
 * is not a layer, so with nothing open Esc does nothing here and is left to whatever else listens.
 *
 * Pure: no React and no DOM, so the order is unit-tested (tests/unit/v12-overlay-stack.spec.ts). components/v12/ui/
 * overlay.tsx binds it to the page.
 */

export const ESC_ORDER = ["viewer", "join", "rig", "menu", "tool", "selection", "drawer"] as const;
export type OverlayLayer = (typeof ESC_ORDER)[number];

export type OverlayEntry = {
  id: number;
  layer: OverlayLayer;
  /** Closes it. Called at most once per Esc or outside click. */
  close: () => void;
  /** True when the node is inside this layer (its panel, or the control that opened it): an outside click spares it. */
  contains?: (node: unknown) => boolean;
  /** Closes on a click outside it. Menus, popovers and sheets do; a tool, a selection or a drawer keeps its own rule. */
  outside?: boolean;
};

export type OverlayStack = {
  /** Registers an open layer. Returns the function that unregisters it (on close or unmount). */
  open: (entry: Omit<OverlayEntry, "id">) => () => void;
  /** Esc: closes the top-most layer and returns what it closed (empty when nothing was open). */
  escape: () => OverlayEntry[];
  /** A pointer went down on `node`: closes every outside-closing layer that does not contain it. */
  pointerDown: (node: unknown) => OverlayEntry[];
  /** What is open, top-most first. */
  list: () => OverlayEntry[];
  /** The top-most open layer, or null. */
  top: () => OverlayEntry | null;
  subscribe: (listener: () => void) => () => void;
};

const rank = (layer: OverlayLayer) => ESC_ORDER.indexOf(layer);

export function createOverlayStack(): OverlayStack {
  let entries: OverlayEntry[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };

  /* Top-most first: by layer, then the one opened last. */
  const list = () => [...entries].sort((a, b) => rank(a.layer) - rank(b.layer) || b.id - a.id);

  const remove = (gone: OverlayEntry[]) => {
    if (!gone.length) return;
    const ids = new Set(gone.map((entry) => entry.id));
    entries = entries.filter((entry) => !ids.has(entry.id));
    changed();
    for (const entry of gone) entry.close();
  };

  return {
    open(entry) {
      const full: OverlayEntry = { ...entry, id: next++ };
      entries = [...entries, full];
      changed();
      return () => {
        if (!entries.some((e) => e.id === full.id)) return;
        entries = entries.filter((e) => e.id !== full.id);
        changed();
      };
    },
    escape() {
      const [first] = list();
      if (!first) return [];
      remove([first]);
      return [first];
    },
    pointerDown(node) {
      const gone = entries.filter((entry) => entry.outside && !(entry.contains?.(node) ?? false));
      /* A click inside a menu spares the menus under it (a submenu's parent, a popover's own picker). */
      const inside = entries.filter((entry) => entry.outside && (entry.contains?.(node) ?? false));
      const keep = inside.length ? Math.min(...inside.map((entry) => entry.id)) : Infinity;
      const closing = gone.filter((entry) => !(entry.layer === "menu" && inside.some((i) => i.layer === "menu") && entry.id < keep));
      remove(closing);
      return closing;
    },
    list,
    top: () => list()[0] ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
