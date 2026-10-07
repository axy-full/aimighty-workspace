import { normalize } from "./ia";
import { resolvePageId, suiteOfPage } from "@/lib/workspace/pages";
import { fromMakeLink, MAKE_SCREEN } from "./make";
import { applyRows, matchRow, type Row } from "./screen-rows";
import { HOME_SCREEN } from "@/components/graphite/home/routes";
import { BOARD_SCREEN } from "@/lib/board/routes";
import { ADS_SCREEN, SOCIAL_SCREEN } from "./ads-social";
import { ATOMIK_SCREEN } from "@/components/graphite/atomik/panel/routes";
import { CONTROL_ROOM_SCREEN } from "@/lib/control-room/routes";
import { SETTINGS_SCREEN } from "./settings";
import { PHONE_SCREEN } from "@/components/graphite/phone/routes";

export type { Row } from "./screen-rows";

/**
 * The screen registry: how the shell knows which new screens exist and where their addresses go.
 *
 * Each stream declares its screen in ONE pure module it owns (never React, never a fetch), so the server, the
 * client bundle and the unit specs read the same facts:
 *  - `landed`: whether the screen exists; a screen that has not landed shows nothing and its addresses fall back;
 *  - `params`: the URL params the screen owns; the shell keeps them across its own address writes;
 *  - `rows`: old address → new address, applied once the screen has landed;
 *  - `fallback`: new address → today's page, applied while the screen has not landed;
 *  - `normalize`: an optional spelling the screen reads (e.g. the design's `frame` letters).
 * Streams edit only their own module. The shell (stream 1) imports them all; nobody else edits this file.
 *
 * Every address then runs one pipeline, on the server (app/suites/page.tsx, one 307 for a signed-in request) and
 * again on the client as the shell lands (lib/shell/state.tsx): the design's spellings (lib/shell/ia.ts ›
 * normalize), each module's `normalize`, Make's old Gen and Viral addresses (lib/shell/make.ts), then the rows.
 * Every screen shows for everyone (Release 1: the new-interface switch is gone).
 */
export type ScreenId = "home" | "board" | "board-ads" | "board-social" | "make" | "atomik" | "control-room" | "settings" | "phone";
export type ScreenModule = {
  id: ScreenId;
  landed: boolean;
  params: readonly string[];
  rows: readonly Row[];
  fallback: readonly Row[];
  normalize?: (q: URLSearchParams) => boolean;
};

export const SCREENS: readonly ScreenModule[] = [HOME_SCREEN, BOARD_SCREEN, ADS_SCREEN, SOCIAL_SCREEN, MAKE_SCREEN, ATOMIK_SCREEN, CONTROL_ROOM_SCREEN, SETTINGS_SCREEN, PHONE_SCREEN];

/** A kind of board draws on the board itself: it counts as landed only once both have. */
const NEEDS: Readonly<Partial<Record<ScreenId, readonly ScreenId[]>>> = { "board-ads": ["board"], "board-social": ["board"] };

export function isLanded(id: ScreenId, screens: readonly ScreenModule[] = SCREENS): boolean {
  const own = screens.find((s) => s.id === id);
  return Boolean(own?.landed) && (NEEDS[id] ?? []).every((need) => isLanded(need, screens));
}

/** Every param a landed screen owns, for the shell to keep across its own address writes. */
export function screenParams(screens: readonly ScreenModule[] = SCREENS): string[] {
  return [...new Set(screens.filter((s) => isLanded(s.id, screens)).flatMap((s) => [...s.params]))];
}

/** Whether two searches carry the same params, whatever their order. */
export function sameSearch(a: string, b: string): boolean {
  const sorted = (s: string) => [...new URLSearchParams(s).entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  return sorted(a) === sorted(b);
}

const text = (q: URLSearchParams) => (q.toString() ? `?${q.toString()}` : "");

/**
 * Steps 1 to 3 of the pipeline, in both modes: the design file's spellings become the app's, each screen reads its
 * own spellings, and the old Gen page and Viral's two quick tools become Make's addresses.
 */
export function spelling(search: string, screens: readonly ScreenModule[] = SCREENS): string {
  const spelled = normalize(search);
  const moved = fromMakeLink(spelled);
  const q = new URLSearchParams(moved === null ? spelled : moved);
  for (const screen of screens) screen.normalize?.(q);
  return text(q);
}

/** The views the shell still has (Release 1): Home, the board and Settings. `crew`, `suite`, `gen` and anything else are not views. */
const VIEWS: readonly string[] = ["home", "board", "workspace"];

/**
 * The last step of `route`: what no row moved. Release 1 has no old page, so an address that names none of the shell's
 * places is never left to open one. Crew's pages (`cp`, `room`) and the Studio overview and its Home (`page=brief&sp=stages|home`,
 * which are Home) are gone, and a suite no row took (an unknown `sp`, a bare `suite=particl`) holds nothing a link can open: it lands on
 * the board when it names a take (`asset`, `sel`, `import`), else on Home. Atomik's control room (`suite=atomik`) is the one place that keeps
 * its `suite` and `page`; a view that is not Home, the board or Settings is dropped (`view=crew`, `view=suite`).
 */
function settle(q: URLSearchParams): void {
  q.delete("cp"); q.delete("crew"); q.delete("room");
  const view = q.get("view");
  if (view && !VIEWS.includes(view)) q.delete("view");
  if (q.has("view") || q.get("suite") === "atomik") return;
  for (const key of ["suite", "page", "sp", "rig", "beats"]) q.delete(key);
  q.set("view", ["asset", "sel", "import"].some((key) => q.has(key)) ? "board" : "home");
}

/** Before everything: a view the shell never had (`view=suite`, `view=nonsense`) is no view, so the spellings and the rows for the old pages see the address as it is. `crew` stays: the board's rows take it. */
const withoutOddView = (search: string): string => {
  const q = new URLSearchParams(search);
  const view = q.get("view");
  if (view && view !== "crew" && view !== "gen" && view !== "make" && !VIEWS.includes(view)) q.delete("view");
  return text(q);
};

/** A page id names its suite (lib/workspace/navigation.ts › fromSearch: the page is the more specific claim), so a link may leave `suite` out. */
function withSuite(search: string): string {
  const q = new URLSearchParams(search);
  const page = resolvePageId(q.get("page"));
  if (!q.has("view") && !q.has("suite") && page) q.set("suite", suiteOfPage(page));
  return text(q);
}

/** The rows that apply: the landed screens' `rows`; every other screen's `fallback`. */
function activeRows(screens: readonly ScreenModule[]): { rows: Row[]; fallback: Row[] } {
  const rows: Row[] = [], fallback: Row[] = [];
  for (const screen of screens) {
    if (isLanded(screen.id, screens)) rows.push(...screen.rows);
    else fallback.push(...screen.fallback);
  }
  return { rows, fallback };
}

/**
 * The address the shell opens for `search`: the spellings, then the rows, then (with Home landed) `settle`: Home for a bare landing. One pass: a row's target is never another row's source (tests/unit/demo-s01-routes.spec.ts
 * holds that), so the result is final.
 */
export function route(search: string, screens: readonly ScreenModule[] = SCREENS): string {
  const spelled = withSuite(spelling(withoutOddView(search), screens));
  const { rows, fallback } = activeRows(screens);
  /* `q` is shared with ⌘K's own search words (`find=1&q=…`), so it is never dropped with a screen's params. */
  const params = screenParams(screens).filter((key) => key !== "q");
  /* The two row sets compete as one: the most specific row wins (a tie goes to old → new), and a row back to an old
     page takes the new screen's own params with it. */
  const forward = matchRow(spelled, rows), back = matchRow(spelled, fallback);
  const weight = (row: Row | null) => (row ? [...new URLSearchParams(row.from).keys()].length : -1);
  const moved = forward && weight(forward) >= weight(back) ? applyRows(spelled, [forward]) : back ? applyRows(spelled, [back], ["view", ...params]) : null;
  const q = new URLSearchParams(moved ?? spelled);
  if (isLanded("home", screens)) settle(q);
  return text(q);
}

/** The kinds of board (lib/board, stream 3): the board's `kind=` param, and a project's own kind. */
export type BoardKindId = "studio" | "ads" | "social";

/**
 * The new screen a place in the shell mounts, or null for one of today's pages.
 * `controlRoom`: the place is one of Atomik's four control-room pages (Approvals, Runs, Memory, Skills).
 */
export function screenOf(at: { view: string | null; kind: string | null; controlRoom: boolean }, screens: readonly ScreenModule[] = SCREENS): ScreenId | null {
  if (at.view === "home") return isLanded("home", screens) ? "home" : null;
  if (at.view === "board") {
    if (at.kind === "ads" && isLanded("board-ads", screens)) return "board-ads";
    if (at.kind === "social" && isLanded("board-social", screens)) return "board-social";
    return isLanded("board", screens) ? "board" : null;
  }
  if (at.view === "workspace") return isLanded("settings", screens) ? "settings" : null;
  if (at.view === "crew" || at.view === "gen") return null;
  return at.controlRoom && isLanded("control-room", screens) ? "control-room" : null;
}

/** The new screen an address mounts (see `screenOf`). */
export function screenAt(search: string | URLSearchParams, screens: readonly ScreenModule[] = SCREENS): ScreenId | null {
  const q = new URLSearchParams(search);
  const page = q.get("page"), sp = q.get("sp");
  const controlRoom = q.get("suite") === "atomik" && (page === "approvals" || page === "runs" || (page === "agent" && (sp === "memory" || sp === "saved-skills")));
  return screenOf({ view: q.get("view"), kind: q.get("kind"), controlRoom }, screens);
}

type Query = string | URLSearchParams | Readonly<Record<string, string>>;
const asQuery = (value: Query): URLSearchParams => (typeof value === "string" || value instanceof URLSearchParams ? new URLSearchParams(value) : new URLSearchParams(value as Record<string, string>));

/** Atomik's panel as the address asks for it (`atomik=1` or `atomik=how`), or null (closed, or not landed). */
export function atomikAt(search: Query, screens: readonly ScreenModule[] = SCREENS): "panel" | "how" | null {
  if (!isLanded("atomik", screens)) return null;
  const value = asQuery(search).get("atomik");
  return value === "1" ? "panel" : value === "how" ? "how" : null;
}

/** The phone's own screens: compact widths, or `device=phone` at any width (a centred frame). Landed only. */
export function phoneAt(search: Query, compact: boolean, screens: readonly ScreenModule[] = SCREENS): { on: boolean; framed: boolean } {
  if (!isLanded("phone", screens)) return { on: false, framed: false };
  const framed = asQuery(search).get("device") === "phone";
  return { on: compact || framed, framed: framed && !compact };
}
