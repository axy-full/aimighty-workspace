import {
  PAGES,
  firstPage,
  pageKind,
  resolvePageId,
  resolveSuite,
  suiteOfPage,
} from "./pages";
import type {
  AppState,
  LibFilter,
  PageId,
  SelKind,
  SelectableItem,
  SelectableLists,
  Suite,
} from "./types";

export const INITIAL_STATE: AppState = {
  view: "home",
  suite: "particl",
  page: "brief",
  projectId: null,
  rigView: "list",
  libFilter: "All",
  libTab: "tools",
  scope: "mine",
  inspTab: "Controls",
  selKind: "page",
  selId: null,
  inspector: true,
  palette: false,
  query: "",
  agentOpen: false,
  composer: false,
  run: null,
  completed: {},
  activity: [],
  gen: null,
  playing: false,
  playhead: 0,
  toast: "",
  lists: { shots: null, takes: null, cast: null },
};

/** Takes respect the active filter, so selection never lands on a hidden card. */
export function visibleTakes(takes: SelectableItem[] | null, filter: LibFilter): SelectableItem[] | null {
  if (!takes) return null;
  if (filter === "All") return takes;
  const kind = filter === "Uploads" ? "upload" : "generation";
  return takes.filter((take) => take.kind === kind);
}

/** The list a selection of `kind` must belong to, or null while it loads. */
export function listFor(kind: SelKind, lists: SelectableLists, filter: LibFilter): SelectableItem[] | null {
  if (kind === "shot") return lists.shots;
  if (kind === "take") return visibleTakes(lists.takes, filter);
  if (kind === "cast") return lists.cast;
  return null;
}

/**
 * The selection repair from 04, generalised to real lists. Arriving at a page
 * whose Inspector walks a list must leave `selId` pointing into that list —
 * otherwise Rig reached from Takes holds a take id, and Generate has no shot.
 *
 *  - list not loaded yet: keep the id only if it was already this kind
 *    (a `sel=shot:…` URL), and let `setLists` repair it on arrival;
 *  - list loaded and the id is in it: keep it;
 *  - list loaded, id missing: the first item;
 *  - list loaded and empty: null, and actions that need a selection say why.
 */
export function repairSelection(
  state: Pick<AppState, "selKind" | "selId" | "lists" | "libFilter">,
  page: PageId,
): { selKind: SelKind; selId: string | null } {
  const kind = pageKind(page);
  if (kind === "page") return { selKind: "page", selId: state.selId };
  const list = listFor(kind, state.lists, state.libFilter);
  if (list === null) return { selKind: kind, selId: state.selKind === kind ? state.selId : null };
  if (state.selId && list.some((item) => item.id === state.selId)) return { selKind: kind, selId: state.selId };
  return { selKind: kind, selId: list[0]?.id ?? null };
}

/**
 * The single navigation entry point. Unknown pages fall back to the suite's
 * first page; former page ids resolve through their aliases.
 */
export function go(state: AppState, suite: Suite, page: string): AppState {
  const list = PAGES[suite] ?? PAGES.particl;
  const resolved = resolvePageId(page);
  const id = resolved && list.some((p) => p.id === resolved) ? resolved : list[0].id;
  const sel = repairSelection(state, id);
  return { ...state, view: "studio", suite, page: id, ...sel, inspTab: "Controls" };
}

/** Home for a suite: the page is kept as that suite's first, selection untouched. */
export function goHome(state: AppState, suite: Suite = state.suite): AppState {
  return { ...state, view: "home", suite, page: suite === state.suite ? state.page : firstPage(suite) };
}

/** Suite pill: stays in the current view; in the studio it opens the suite's first page. */
export function switchSuite(state: AppState, suite: Suite): AppState {
  if (state.view === "home") return { ...state, suite, page: firstPage(suite), selKind: "page", inspTab: "Controls" };
  return go(state, suite, firstPage(suite));
}

/** Loaded lists arrive (or change): re-run the repair for the current page. */
export function withLists(state: AppState, lists: Partial<SelectableLists>): AppState {
  const next = { ...state, lists: { ...state.lists, ...lists } };
  if (next.view !== "studio") return next;
  return { ...next, ...repairSelection(next, next.page) };
}

/** The Takes filter changes the visible list, so the selection is repaired too. */
export function withLibFilter(state: AppState, libFilter: LibFilter): AppState {
  const next = { ...state, libFilter };
  if (next.view !== "studio") return next;
  return { ...next, ...repairSelection(next, next.page) };
}

/* ← → item navigation lives in lib/workspace/keys.ts (stepSelection over the visible list). */

/* ── URL ──────────────────────────────────────────────────────────────── */

export const WORKSPACE_PATH = "/workspace";
const SEL_KINDS: SelKind[] = ["shot", "take", "cast"];

/** `/workspace?project=&suite=&page=&sel=` — no page means the home view. */
export function toSearch(state: Pick<AppState, "projectId" | "suite" | "page" | "view" | "selKind" | "selId">): string {
  const query = new URLSearchParams();
  if (state.projectId) query.set("project", state.projectId);
  query.set("suite", state.suite);
  if (state.view === "studio") {
    query.set("page", state.page);
    if (state.selId && state.selKind !== "page") query.set("sel", `${state.selKind}:${state.selId}`);
  }
  return "?" + query.toString();
}

export function toHref(state: Parameters<typeof toSearch>[0]) {
  return WORKSPACE_PATH + toSearch(state);
}

export type UrlState = {
  projectId: string | null;
  suite: Suite;
  view: AppState["view"];
  page: PageId;
  sel: { kind: SelKind; id: string } | null;
};

/**
 * Read the URL back. A page wins over a disagreeing suite (the page is the
 * more specific claim); aliases resolve; an unknown page opens the suite's
 * first page.
 */
export function fromSearch(search: string): UrlState {
  const query = new URLSearchParams(search);
  const rawPage = query.get("page");
  const page = resolvePageId(rawPage);
  const suite = page ? suiteOfPage(page) : resolveSuite(query.get("suite")) ?? "particl";
  const rawSel = query.get("sel");
  let sel: UrlState["sel"] = null;
  if (rawSel) {
    const at = rawSel.indexOf(":");
    const kind = rawSel.slice(0, at) as SelKind;
    const id = rawSel.slice(at + 1);
    if (at > 0 && id && SEL_KINDS.includes(kind)) sel = { kind, id };
  }
  return {
    projectId: query.get("project") || null,
    suite,
    view: rawPage === null ? "home" : "studio",
    page: page ?? firstPage(suite),
    sel,
  };
}

/** Apply a URL to state (initial load and popstate), repairing selection. */
export function applyUrl(state: AppState, url: UrlState): AppState {
  const base: AppState = {
    ...state,
    projectId: url.projectId ?? state.projectId,
    suite: url.suite,
    page: url.page,
    view: url.view,
  };
  if (url.view === "home") return base;
  const seeded = url.sel ? { ...base, selKind: url.sel.kind, selId: url.sel.id } : base;
  return { ...seeded, ...repairSelection(seeded, url.page), inspTab: "Controls" };
}

/* ── Actions that need a selection ────────────────────────────────────── */

export type Availability = { enabled: true; reason: null } | { enabled: false; reason: string };

/**
 * Generate needs a selected shot. When it cannot run, the reason is shown —
 * never a button that silently does nothing.
 */
export function generateAvailability(
  state: Pick<AppState, "page" | "selKind" | "selId" | "lists">,
  connected: boolean,
): Availability {
  if (state.page !== "rig") return { enabled: false, reason: "Generate works on a shot in Rig." };
  const shots = state.lists.shots;
  if (shots !== null && shots.length === 0) return { enabled: false, reason: "Add a shot before generating." };
  if (state.selKind !== "shot" || !state.selId || (shots !== null && !shots.some((s) => s.id === state.selId)))
    return { enabled: false, reason: "Select a shot to generate." };
  if (!connected) return { enabled: false, reason: "Generation is not connected to this view yet." };
  return { enabled: true, reason: null };
}

/**
 * What G (and the palette's Generate row) does. The Rig's own Generate owns a
 * selected shot; anything else — no shot, another page, Home — opens the
 * global composer, which is the point of having one.
 */
export function generateTarget(
  state: Pick<AppState, "view" | "page" | "selKind" | "selId" | "lists">,
  connected: boolean,
): "rig" | "composer" {
  return generateAvailability(state, connected).enabled ? "rig" : "composer";
}
