/**
 * Page state and suite progress, derived — the one definition both the
 * project cards and the stage list read (04 "Derived values — never
 * hardcode these"; 05-mobile "never hardcode them").
 *
 * A page is complete when a run completed it, in progress while a run holds
 * it, and not started otherwise. That is everything the workspace knows
 * today, so it is everything these counters claim: a figure the data cannot
 * support is left out rather than invented.
 */

import { PAGES } from "./pages";
import type { AppState, PageId, Suite } from "./types";

export type PageStateId = "done" | "progress" | "empty";

/** Plain words, not a status vocabulary of their own (05-mobile, Suite rows). */
export const PAGE_STATE_LABEL: Record<PageStateId, string> = {
  done: "Complete",
  progress: "In progress",
  empty: "Not started",
};

export const PAGE_STATE_COLOR: Record<PageStateId, string> = {
  done: "var(--pxw-green)",
  progress: "var(--pxw-blue-ink)",
  empty: "var(--pxw-neutral-state)",
};

export type ProgressState = Pick<AppState, "completed" | "run">;

export function pageStateOf(state: ProgressState, page: PageId): PageStateId {
  if (state.completed[page]) return "done";
  if (state.run?.page === page && state.run.status !== "done") return "progress";
  return "empty";
}

export type SuiteProgress = {
  /** How many pages the suite has — 8 for the studio, and never a literal. */
  total: number;
  done: number;
  inProgress: number;
  /** 0–100, for the 3px bar. */
  pct: number;
  /** The one page in progress, when exactly one is: "Rig in progress". */
  activeLabel: string | null;
};

export function suiteProgress(state: ProgressState, suite: Suite): SuiteProgress {
  const pages = PAGES[suite] ?? PAGES.particl;
  const states = pages.map((page) => ({ page, state: pageStateOf(state, page.id) }));
  const done = states.filter((item) => item.state === "done").length;
  const running = states.filter((item) => item.state === "progress");
  return {
    total: pages.length,
    done,
    inProgress: running.length,
    pct: pages.length ? Math.round((done / pages.length) * 100) : 0,
    activeLabel: running.length === 1 ? running[0].page.label : null,
  };
}

const n = (value: number) => value.toLocaleString("en-US");

/**
 * The project card's line: "5 of 8 stages · Rig in progress". The second
 * clause names the page when one page is running, counts them when several
 * are, and is absent when none is — the design's "· ready to deliver" is a
 * prototype fixture and is not claimed here.
 */
export function stagesLine(progress: SuiteProgress, word = "stages"): string {
  const head = `${n(progress.done)} of ${n(progress.total)} ${word}`;
  if (!progress.inProgress) return head;
  const tail = progress.activeLabel ? `${progress.activeLabel} in progress` : `${n(progress.inProgress)} in progress`;
  return `${head} · ${tail}`;
}

/** The project card's 5px state dot: green delivered, blue working, grey idle. */
export function progressDot(progress: SuiteProgress): string {
  if (progress.total && progress.done === progress.total) return "var(--pxw-green)";
  if (progress.inProgress) return "var(--pxw-blue-ink)";
  return "var(--pxw-neutral-state)";
}
