import { SUITES as BASE_SUITES, PARTICL_STAGE_ALIASES } from "@/lib/suites";
import type { AppState, PageId, SelKind, Suite } from "./types";

/* ── Suites ───────────────────────────────────────────────────────────────
   Names and identity dots come from lib/suites.ts; the workspace adds the
   short tab label, the wordmark caps and the one-line description. */

const SUITE_EXTRA: Record<Suite, { short: string; mark: string; blurb: (pages: number) => string }> = {
  particl: { short: "Studio", mark: "STUDIO", blurb: (n) => `The production studio. ${countWord(n)} stages from brief to delivery.` },
  atomik: { short: "Agent", mark: "AGENT", blurb: () => "The production agent. Plans, prices and runs the work." },
  moleculr: { short: "Business", mark: "BUSINESS", blurb: () => "Build and grow your brand from one marketing studio." },
  subatomik: { short: "Viral", mark: "VIRAL", blurb: () => "Recast motion and swap elements in footage you own." },
};

export type WorkspaceSuite = {
  id: Suite;
  name: string;
  short: string;
  mark: string;
  desc: string;
  dot: string;
};

/* ── Pages ────────────────────────────────────────────────────────────── */

export type ViewOption = { id: string; label: string };

/** What the blue primary button in the page header does. */
export type PrimaryAction =
  | { kind: "generate"; label: "Generate"; key: "G" }
  | { kind: "upload"; label: "+ Upload"; key: null }
  | { kind: "add-cast"; label: "+ Add cast"; key: null }
  | { kind: "run-stage"; label: "+ Run stage"; key: "A" };

export type PageDef = {
  id: PageId;
  suite: Suite;
  /** Stage-tab label, abbreviated so every tab fits one row. */
  label: string;
  /** Page title, never truncated. */
  title: string;
  /** One sentence for the home feature card. */
  description: string;
};

const page = (suite: Suite, id: PageId, label: string, title: string, description: string): PageDef =>
  ({ id, suite, label, title, description });

export const PAGES: Record<Suite, PageDef[]> = {
  particl: [
    page("particl", "brief", "Brief", "Brief & Script", "The brief, the script and the development passes read and write the same document."),
    page("particl", "boards", "Boards", "Boards", "Boards follow the script."),
    page("particl", "cast", "Cast", "Cast & Elements", "Groups references, builds each identity and binds it to the shots that cite it."),
    page("particl", "astra", "Astra", "Astra", "Blocking before rendering."),
    page("particl", "rig", "Rig", "Rig", "Resolves references, quotes each shot and dispatches it to a video engine."),
    page("particl", "takes", "Takes", "Takes", "Compares versions against the director’s note and marks what is worth cutting with."),
    page("particl", "edit", "Edit", "Edit & Sound", "Assembles the approved takes, then writes dialogue, effects and music against the cut."),
    page("particl", "deliver", "Deliver", "Deliver", "Delivery runs against the spec saved on the project."),
  ],
  atomik: [
    page("atomik", "agent", "Agent", "Agent", "Describe the outcome; the agent plans it against this project, prices it, and waits for you before anything paid runs."),
    page("atomik", "runs", "Runs", "Runs", "Every agent action becomes a durable run."),
    page("atomik", "generate", "Generate", "Generate", "Image, video, sound and 3D workflows from the connected account’s catalogue, plus tools and voice."),
    page("atomik", "recipes", "Recipes", "Recipes", "A recipe is a saved plan that reruns exactly — same steps, same inputs, same engines."),
    page("atomik", "builds", "Builds", "Builds", "Describe a tool and the agent builds it — interface, data, sign-in and generation models wired in."),
    page("atomik", "skills", "Skills", "Skills", "Skills are the tool packs the agent can reach."),
    page("atomik", "models", "Models", "Models", "Thinking model and effort for planning; generation engines for output."),
    page("atomik", "approvals", "Approvals", "Approvals", "Nothing paid happens without an approval."),
    page("atomik", "budget", "Budget", "Budget", "Settled accounting, not estimates."),
  ],
  moleculr: [
    page("moleculr", "marketing", "Marketing Studio", "Marketing Studio", "One studio: a product, who presents it, what it says and where it runs."),
  ],
  subatomik: [
    page("subatomik", "motion", "Motion Transfer", "Motion Transfer", "Take the motion from a source video and recast it with your own cast, location and product."),
    page("subatomik", "swap", "Object Swap", "Object Swap", "Swap one element — a product, a garment, an object — and leave the rest of the shot exactly as filmed."),
    page("subatomik", "shorts", "Shorts", "Shorts", "Restyle one video into a set of short clips; one quote covers the whole set."),
    page("subatomik", "sources", "Sources", "Sources", "Sources are your own originals."),
    page("subatomik", "compare", "Compare", "Compare", "Put the original and the result side by side, locked to the same clock."),
    page("subatomik", "history", "History", "History", "Every result is copied into private storage on completion."),
  ],
};

export const SUITE_ORDER: Suite[] = BASE_SUITES.map((s) => s.id);

export const SUITES: WorkspaceSuite[] = BASE_SUITES.map((s) => ({
  id: s.id,
  name: s.name,
  dot: s.color,
  short: SUITE_EXTRA[s.id].short,
  mark: SUITE_EXTRA[s.id].mark,
  desc: SUITE_EXTRA[s.id].blurb(PAGES[s.id].length),
}));

export const ALL_PAGES: PageDef[] = SUITE_ORDER.flatMap((s) => PAGES[s]);

/**
 * Former page IDs from lib/suites.ts (and the retired stage IDs it already
 * aliases) open the page that now holds their work.
 */
export const PAGE_ALIASES: Record<string, PageId> = {
  storyboard: "boards",
  characters: "cast",
  "astra-blender": "astra",
  canvas: "rig",
  assets: "takes",
  export: "deliver",
  "motion-transfer": "motion",
  "object-swap": "swap",
};

export const SUITE_ALIASES: Record<string, Suite> = { subatomic: "subatomik" };

export function isSuite(value: unknown): value is Suite {
  return typeof value === "string" && (SUITE_ORDER as string[]).includes(value);
}

export function resolveSuite(value: string | null | undefined): Suite | null {
  if (!value) return null;
  if (isSuite(value)) return value;
  return SUITE_ALIASES[value] ?? null;
}

export function getSuite(id: Suite): WorkspaceSuite {
  return SUITES.find((s) => s.id === id) ?? SUITES[0];
}

export function pageDef(id: PageId): PageDef {
  return ALL_PAGES.find((p) => p.id === id) ?? PAGES.particl[0];
}

/** A current page id, a former id, or a retired stage id, to a current page id. */
export function resolvePageId(value: string | null | undefined): PageId | null {
  if (!value) return null;
  const direct = ALL_PAGES.find((p) => p.id === value);
  if (direct) return direct.id;
  if (PAGE_ALIASES[value]) return PAGE_ALIASES[value];
  const stage = PARTICL_STAGE_ALIASES[value];
  if (stage) return resolvePageId(stage);
  return null;
}

export function suiteOfPage(id: PageId): Suite {
  return pageDef(id).suite;
}

export function firstPage(suite: Suite): PageId {
  return PAGES[suite][0].id;
}

/** Which list the Inspector and the arrow keys walk on this page. */
export function pageKind(id: PageId): SelKind {
  return id === "takes" ? "take" : id === "cast" ? "cast" : id === "rig" ? "shot" : "page";
}

export function primaryAction(id: PageId): PrimaryAction {
  if (id === "rig") return { kind: "generate", label: "Generate", key: "G" };
  if (id === "takes") return { kind: "upload", label: "+ Upload", key: null };
  if (id === "cast") return { kind: "add-cast", label: "+ Add cast", key: null };
  return { kind: "run-stage", label: "+ Run stage", key: "A" };
}

/** The page-header segmented control, where the page has views. */
export function pageViews(id: PageId): ViewOption[] {
  if (id === "rig") return [{ id: "list", label: "List" }, { id: "graph", label: "Canvas" }];
  if (id === "takes")
    return [{ id: "All", label: "All" }, { id: "Uploads", label: "Uploads" }, { id: "Generations", label: "Generations" }];
  return [];
}

export function crumbFor(state: Pick<AppState, "page" | "suite" | "rigView">) {
  const def = pageDef(state.page);
  return {
    crumb: state.page === "rig" ? "Main composition" : def.title,
    kicker: state.page === "rig" && state.rigView === "graph" ? "NODE GRAPH" : getSuite(state.suite).mark,
  };
}

/* ── Library ──────────────────────────────────────────────────────────── */

export type LibraryItem = { name: string; sub: string };
export type LibraryGroup = { title: string; items: LibraryItem[] };

const g = (title: string, items: [string, string][]): LibraryGroup =>
  ({ title, items: items.map(([name, sub]) => ({ name, sub })) });

/** Rig, Cast, Takes and Edit have their own tool lists (prototype `LIB`). */
export const LIBRARY: Partial<Record<PageId, LibraryGroup[]>> = {
  rig: [
    g("REFERENCES", [["Brief", "Write · Annotate"], ["Look board", "Collect · Grade"], ["Character", "Identity · Wardrobe"], ["World & element", "Reference · Transform"], ["Media", "Import · Preview"]]),
    g("CREATE", [["Scene", "Compose · Direct"], ["Generate", "Prompt · References"]]),
    g("FINISH", [["Composite", "Blend · Mask"], ["Colour", "Grade · Compare"], ["Transform", "Scale · Rotate"], ["Sound", "Listen · Gain"]]),
    g("FLOW", [["Switch", "Route · Compare"], ["Version", "Branch · Pin"], ["Approve", "Price · Gate"], ["Export", "Package · Send"]]),
  ],
  cast: [
    g("CAST", [["Identity", "Lock · Reuse"], ["Wardrobe", "Views · Fit"], ["Casting", "Search · Compare"]]),
    g("ELEMENTS", [["Object", "Reference · Scale"], ["Environment", "Plate · Light"], ["Prop", "Import · Tag"]]),
  ],
  takes: [
    g("FILTER", [["All assets", "Uploads · Generations"], ["Uploads", "Byte-identical"], ["Generations", "Settled cost"]]),
    g("ACTIONS", [["Compare", "Split · Wipe"], ["Approve", "Mark · Version"], ["Send to edit", "Assembly"]]),
  ],
  edit: [
    g("PICTURE", [["Assembly", "Order · Trim"], ["Colour match", "Across takes"], ["Versions", "Branch · Pin"]]),
    g("SOUND", [["Dialogue", "Voice · Language"], ["Sound effects", "Cues · Layers"], ["Ambience", "Bed · Loop"], ["Music score", "Mood · Length"], ["Mix", "Loudness · Balance"]]),
  ],
};

/** The spec-card groups a page shows; filled by the spec-card PR. */
export type SpecCardGroup = { title: string; cards: { name: string; chips: string[] }[] };
export const SPEC_GROUPS: Partial<Record<PageId, SpecCardGroup[]>> = {};

/** Every other page derives its tools from its spec-card groups. */
export function libraryFor(id: PageId, specGroups: Partial<Record<PageId, SpecCardGroup[]>> = SPEC_GROUPS): LibraryGroup[] {
  const own = LIBRARY[id];
  if (own) return own;
  return (specGroups[id] ?? []).map((group) => ({
    title: group.title,
    items: group.cards.map((card) => ({ name: card.name, sub: card.chips.join(" · ") })),
  }));
}

export function libraryCount(groups: LibraryGroup[]) {
  return groups.reduce((n, group) => n + group.items.length, 0);
}

/* ── Derived page subtitles ──────────────────────────────────────────── */

/** What the shell knows about the project without any page body loaded. */
export type SubtitleData = {
  aspect?: string | null;
  fps?: number | null;
};

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The page header's second line. Every figure is counted from loaded data;
 * a page whose data is not loaded yet shows nothing rather than a guess.
 */
export function subtitle(state: Pick<AppState, "page" | "lists">, data: SubtitleData = {}): string {
  const { shots, takes, cast } = state.lists;
  switch (state.page) {
    case "rig":
      return shots ? `${plural(shots.length, "shot")} · ${shots.filter((s) => s.status === "approved").length.toLocaleString("en-US")} approved` : "";
    case "takes":
      return takes ? plural(takes.length, "asset") : "";
    case "cast":
      return cast
        ? `${cast.filter((c) => c.group !== "elements").length.toLocaleString("en-US")} cast · ${plural(cast.filter((c) => c.group === "elements").length, "element")}`
        : "";
    case "deliver":
      return [data.aspect, data.fps ? `${data.fps} fps` : null].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

function countWord(n: number) {
  const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return words[n] ?? n.toLocaleString("en-US");
}
