/**
 * The header's board tabs (docs/redesign/inventory.md § 5.1): which boards are open as tabs, in the order they were
 * opened, and the ones closed lately (the + popover's "Recently closed"). Home and Make are always there and are not in
 * this list. Kept per person and workspace in the browser (components/v12/shell/use-board-tabs.ts): closing a tab
 * never touches the board, which is kept.
 *
 * Pure: no React, no storage (tests/unit/v12-header-model.spec.ts).
 */
export type TabsState = { open: readonly string[]; closed: readonly string[] };

export const EMPTY_TABS: TabsState = { open: [], closed: [] };
/** Board tabs shown before the rest go under "+N ▾". */
export const MAX_BOARD_TABS = 4;
/** How many closed boards "Recently closed" remembers. */
export const MAX_CLOSED = 5;
/** How many tabs are remembered at all. */
const MAX_OPEN = 24;

const without = (list: readonly string[], id: string) => list.filter((x) => x !== id);

/** A board opened: its tab is added at the end (or stays where it is), and it leaves "Recently closed". */
export function openTab(state: TabsState, id: string): TabsState {
  if (!id) return state;
  if (state.open.includes(id) && !state.closed.includes(id)) return state;
  const open = state.open.includes(id) ? state.open : [...state.open, id].slice(-MAX_OPEN);
  return { open, closed: without(state.closed, id) };
}

/** A tab closed: the board is kept, and it heads "Recently closed". */
export function closeTab(state: TabsState, id: string): TabsState {
  if (!state.open.includes(id)) return state;
  return { open: without(state.open, id), closed: [id, ...without(state.closed, id)].slice(0, MAX_CLOSED) };
}

/** "Close others": every board tab but `keep`, newest closed first. */
export function closeOthers(state: TabsState, keep: string): TabsState {
  return state.open.filter((id) => id !== keep).reduce(closeTab, state);
}

/** Puts a tab back where it was (Undo of a close). */
export function restoreTab(state: TabsState, id: string, index: number): TabsState {
  const open = without(state.open, id);
  const at = Math.max(0, Math.min(index, open.length));
  return { open: [...open.slice(0, at), id, ...open.slice(at)], closed: without(state.closed, id) };
}

/** Boards that no longer exist (deleted, or another workspace's) drop out. Nothing changes until the list is known. */
export function pruneTabs(state: TabsState, known: ReadonlySet<string> | null): TabsState {
  if (!known) return state;
  const open = state.open.filter((id) => known.has(id));
  const closed = state.closed.filter((id) => known.has(id));
  return open.length === state.open.length && closed.length === state.closed.length ? state : { open, closed };
}

/**
 * Which board tabs show and which go under "+N ▾": the first four, except that the open board always shows, taking
 * the last place when it would otherwise be hidden.
 */
export function visibleTabs(open: readonly string[], active: string | null, max = MAX_BOARD_TABS): { shown: string[]; hidden: string[] } {
  if (open.length <= max) return { shown: [...open], hidden: [] };
  let shown = open.slice(0, max);
  if (active && open.includes(active) && !shown.includes(active)) shown = [...shown.slice(0, max - 1), active];
  return { shown, hidden: open.filter((id) => !shown.includes(id)) };
}

/** Where to go when the open board's tab closes: the tab before it, else the one after, else Home. */
export function afterClose(open: readonly string[], closing: string): string | null {
  const at = open.indexOf(closing);
  if (at < 0) return null;
  return open[at - 1] ?? open[at + 1] ?? null;
}

/** Reads a stored value; anything malformed is the empty state. */
export function parseTabs(raw: string | null): TabsState {
  if (!raw) return EMPTY_TABS;
  try {
    const value = JSON.parse(raw) as { open?: unknown; closed?: unknown };
    const ids = (list: unknown, max: number) => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200) : []).slice(0, max);
    return { open: [...new Set(ids(value.open, MAX_OPEN))], closed: [...new Set(ids(value.closed, MAX_CLOSED))] };
  } catch {
    return EMPTY_TABS;
  }
}

/* ── Keys (inventory § 4.2; plan decision 3: ⌘J is Atomik's panel) ───────────── */

export type HeaderKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };
export type HeaderCommand =
  | { go: "home" }
  | { go: "make" }
  | { go: "board"; index: number }
  | { toggle: "atomik" }
  | { pending: "g" };

/**
 * What a key press does in the header, or null. ⌘1 Home, ⌘2 Make, ⌘3… the board tabs in order (`index` into the shown
 * tabs), ⌘J Atomik's panel, and G then H Home. `afterG` is true when the press before was a lone G. Callers skip
 * presses in text fields.
 */
export function headerKey(event: HeaderKey, afterG = false): HeaderCommand | null {
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (mod && !event.altKey && !event.shiftKey) {
    if (event.key === "j" || event.key === "J") return { toggle: "atomik" };
    if (/^[1-9]$/.test(event.key)) {
      const n = Number(event.key);
      return n === 1 ? { go: "home" } : n === 2 ? { go: "make" } : { go: "board", index: n - 3 };
    }
    return null;
  }
  if (mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (afterG && key === "h") return { go: "home" };
  if (key === "g" && !event.shiftKey) return { pending: "g" };
  return null;
}
