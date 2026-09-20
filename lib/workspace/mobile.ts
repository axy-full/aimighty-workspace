/**
 * The phone's view level (05-mobile, "Navigation is a drill-down").
 *
 * The phone is a different shell over the same machine: one state layer, one
 * `go(suite, page)`, one selection repair. What the phone adds is a LEVEL —
 * where in the drill-down the person is standing — because a phone shows one
 * of Projects / Suite / Page at a time where the desktop shows all three at
 * once. Everything here is pure so the drill-down can be tested without a
 * browser, and nothing here knows about React.
 *
 * The level is in the URL (`?level=`) only when it is one the desktop has no
 * equivalent for (Suite, Make, Settings); Projects is the home view and Page
 * is the studio view, exactly as the desktop writes them. A deep link
 * therefore still lands correctly on both surfaces.
 */

import type { AppState, MobileLevel, MobileSheetId } from "./types";

/**
 * Below 768px (design breakpoint), plus a touch phone held landscape — the
 * same second clause the switch-over gate uses, because an 844×390 phone is
 * a phone. Deliberately NOT the gate's own PHONE_QUERY: the gate keeps its
 * 759px for the old entry points until the switch-over PR flips it.
 */
export const MOBILE_QUERY =
  "(max-width: 767px), (hover: none) and (pointer: coarse) and (max-height: 500px)";

export const MOBILE_LEVELS: readonly MobileLevel[] = ["projects", "suite", "page", "make", "settings"];
export const MOBILE_SHEETS: readonly MobileSheetId[] = ["search", "inspector", "atomik", "library"];

/** The URL param. Only the three levels the desktop URL cannot express carry it. */
export const LEVEL_PARAM = "level";
/**
 * A sheet the URL may open on arrival (`?sheet=inspector`). It is read, never
 * written: a sheet is a look at what is already selected, so a deep link can
 * say "open this shot's Inspector" without every open and close pushing
 * history. Only the sheets that read a selection or a page are worth linking.
 */
export const SHEET_PARAM = "sheet";
const URL_LEVELS: readonly MobileLevel[] = ["suite", "make", "settings"];

/** The sheet a URL names, or null. */
export function sheetFromParam(value: string | null | undefined): MobileSheetId | null {
  return value && (MOBILE_SHEETS as readonly string[]).includes(value) ? (value as MobileSheetId) : null;
}

export function isMobileLevel(value: unknown): value is MobileLevel {
  return typeof value === "string" && (MOBILE_LEVELS as readonly string[]).includes(value);
}

/** The level a URL names, or null when it names none. */
export function levelFromParam(value: string | null | undefined): MobileLevel | null {
  return value && isMobileLevel(value) && URL_LEVELS.includes(value) ? value : null;
}

/** The value `?level=` carries for a level, or null when the level needs none. */
export function levelParam(level: MobileLevel): string | null {
  return URL_LEVELS.includes(level) ? level : null;
}

/** Projects and the three siblings are the home view; only Page is the studio. */
export function viewForLevel(level: MobileLevel): AppState["view"] {
  return level === "page" ? "studio" : "home";
}

/**
 * Move to a level. A level change always closes an open sheet: the sheet
 * belongs to the screen it was opened over.
 */
export function withLevel(state: AppState, level: MobileLevel): AppState {
  return { ...state, mobile: level, view: viewForLevel(level), sheet: null };
}

/** Back steps up one level. Make and Settings are siblings, so they step to Projects. */
export function levelAbove(level: MobileLevel): MobileLevel {
  return level === "page" ? "suite" : "projects";
}

export function mobileBack(state: AppState): AppState {
  return withLevel(state, levelAbove(state.mobile));
}

/** The level a URL means: an explicit one, else the page (studio) or Projects. */
export function levelFor(urlLevel: MobileLevel | null, view: AppState["view"]): MobileLevel {
  if (urlLevel) return urlLevel;
  return view === "studio" ? "page" : "projects";
}

/* ── The dock ───────────────────────────────────────────────────────────── */

export type DockTabId = "projects" | "stages" | "make" | "atomik" | "library";

/** Projects · Stages · Make · Atomik · Library. Atomik and Library open sheets. */
export type DockTab =
  | { id: "projects" | "stages" | "make"; label: string; level: MobileLevel }
  | { id: "atomik" | "library"; label: string; sheet: MobileSheetId };

export const DOCK_TABS: readonly DockTab[] = [
  { id: "projects", label: "Projects", level: "projects" },
  { id: "stages", label: "Stages", level: "suite" },
  { id: "make", label: "Make", level: "make" },
  { id: "atomik", label: "Atomik", sheet: "atomik" },
  { id: "library", label: "Library", sheet: "library" },
];

/**
 * A tab reads active for the screen it opens; a sheet tab reads active while
 * its sheet is up (05-mobile, "Dock, 5 tabs"). The Page level sits under
 * Stages: it is the level below it in the same drill-down.
 */
export function dockActive(tab: DockTab, level: MobileLevel, sheet: MobileSheetId | null): boolean {
  if ("sheet" in tab) return sheet === tab.sheet;
  if (sheet) return false;
  if (tab.level === "suite") return level === "suite" || level === "page";
  return level === tab.level;
}
