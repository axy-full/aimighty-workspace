import type { SuiteId } from "@/lib/suites";

/** The four suites share one project; switching suites never changes it. */
export type Suite = SuiteId;

export type ParticlPageId =
  | "brief" | "boards" | "cast" | "astra" | "rig" | "takes" | "edit" | "deliver";
export type AtomikPageId =
  | "agent" | "runs" | "generate" | "recipes" | "builds" | "skills" | "models" | "approvals" | "budget";
export type MoleculrPageId = "marketing";
export type SubatomikPageId = "motion" | "swap" | "shorts" | "sources" | "compare" | "history";
export type PageId = ParticlPageId | AtomikPageId | MoleculrPageId | SubatomikPageId;

export type View = "home" | "studio";
/**
 * The phone's drill-down level (05-mobile). The desktop ignores it; the
 * phone shell reads it instead of adding a second router. Projects and the
 * two siblings are the home view, Page is the studio view.
 */
export type MobileLevel = "projects" | "suite" | "page" | "make" | "settings";
/** The four bottom sheets; every desktop right rail is one of these. */
export type MobileSheetId = "search" | "inspector" | "atomik" | "library";
export type SelKind = "shot" | "take" | "cast" | "page";
export type RunStatus = "running" | "waiting" | "paused" | "done" | "failed";
export type RigView = "list" | "graph";
export type LibFilter = "All" | "Uploads" | "Generations";
export type LibTab = "tools" | "media";
export type Scope = "mine" | "shared";
export type InspTab = "Controls" | "Inputs" | "Versions";

/**
 * The smallest shape selection repair needs from a loaded list. Data hooks
 * (shots, takes, cast) map their real records onto this; nothing here is
 * fixture data.
 */
export type SelectableItem = {
  id: string;
  name: string;
  /** Takes only: which filter tab shows it. */
  kind?: "upload" | "generation";
  /** Shots only: approved / ready / queued / draft / failed. */
  status?: string;
  /** Cast only: "cast" or "elements". */
  group?: "cast" | "elements";
  /** Takes only: billed credits once settled (lib/workspace/takes.ts). */
  credits?: number | null;
};

/**
 * `null` means "not loaded yet": selection is left alone until the list
 * arrives. An empty array means "loaded, and there is nothing": selection
 * becomes null and actions that need one say why they are unavailable.
 */
export type SelectableLists = {
  shots: SelectableItem[] | null;
  takes: SelectableItem[] | null;
  cast: SelectableItem[] | null;
};

export type Run = { page: PageId; i: number; status: RunStatus; approved: boolean };
export type Generation = {
  id: string;
  pct: number;
  name: string;
  meta: string;
  /** The job's own phase when a real job drives the strip ("Failed · not billed"). */
  label?: string;
  tone?: "blue" | "green" | "red";
};

/** 04-interactions-and-state.md, minus the fixture arrays. */
export interface AppState {
  view: View;
  suite: Suite;
  page: PageId;
  projectId: string | null;
  rigView: RigView;
  libFilter: LibFilter;
  libTab: LibTab;
  scope: Scope;
  inspTab: InspTab;

  selKind: SelKind;
  selId: string | null;
  inspector: boolean;

  palette: boolean;
  query: string;
  agentOpen: boolean;
  /** The global Generate composer is open over the current view. */
  composer: boolean;

  run: Run | null;
  completed: Partial<Record<PageId, true>>;
  activity: { label: string; meta: string }[];

  gen: Generation | null;
  playing: boolean;
  playhead: number;
  toast: string;

  lists: SelectableLists;

  /** Phone only: where in the drill-down, and which sheet is up. */
  mobile: MobileLevel;
  sheet: MobileSheetId | null;
}
