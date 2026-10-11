/**
 * The Deliver stage in the new interface (docs/redesign/inventory.md § 6.7; prototype L580, L591): what a finished cut is
 * delivered as, as data. Pure: no React, no fetch (tests/unit/v12-deliver.spec.ts).
 *
 * What is real today: the cut itself (its size, frame rate, length and whether every shot has its approved take: the Deliver
 * card's own checks, components/graphite/board/cards/cut), a free export of it in the browser, and the editorial package
 * (the source media with an EDL, Final Cut / Resolve XML and Premiere XML). What is not: adapting a cut to another size or
 * length, dubbing and lip-syncing it, translated on-screen text, brand mandatories, per-platform packs and posting. Those
 * are drawn as they will be, each saying why it cannot run, and never with a price that no route quoted.
 */

/** The grid's sizes and lengths (prototype: 16:9 · 9:16 · 1:1 · 4:5 × 30 · 15 · 6 s). */
export const GRID_ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;
export const GRID_SECONDS = [30, 15, 6] as const;

export type CellState = "ready" | "waiting" | "notbuilt";
export type DeliverCell = {
  aspect: string;
  /** The column: 0 for the master (the cut as it is), else the grid's length. */
  seconds: number;
  /** "‹project›_16x9_30s_v1". */
  name: string;
  state: CellState;
  /** Why a cell cannot be made, in plain words; null when it can. */
  why: string | null;
};
export type DeliverRow = { aspect: string; cells: DeliverCell[] };

/** What the cut is, from the Deliver card's own data (components/graphite/board/cards/cut/cut-model.ts › CutData). */
export type CutFacts = { aspect: string; seconds: number; complete: boolean; empty: boolean };

export const ADAPT_WHY = "Adapting a cut to another size or length isn’t built yet, so no engine can make or price this version.";
export const MASTER_WAITING = "The cut isn’t finished: every shot needs its approved take.";

/** A file-safe stem for the cut: the project's name, lower case, dashes. Never empty. */
export function nameStem(projectName: string): string {
  const stem = projectName.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return stem.slice(0, 60) || "cut";
}

/** "‹stem›_16x9_30s_v1": the naming pattern of § 6.7, with the project's own stem. A length of 0 (no cut to measure yet) reads "cut". */
export const deliverName = (stem: string, aspect: string, seconds: number): string => `${stem}_${aspect.replace(":", "x")}_${seconds > 0 ? `${seconds}s` : "cut"}_v1`;

export const NAMING_PATTERN = (stem: string) => `${stem}_{aspect}_{dur}_v1`;

/**
 * The grid. Its first column is the master, the cut as it is (its own size and length): ready once the cut is complete,
 * waiting until then. Every other cell is a version that would have to be adapted from the master, which no route does
 * yet: `notbuilt`, with the reason.
 */
export function deliverGrid(stem: string, cut: CutFacts): DeliverRow[] {
  return GRID_ASPECTS.map((aspect) => ({
    aspect,
    cells: [
      {
        aspect, seconds: 0, name: deliverName(stem, aspect, Math.round(cut.seconds)), ...(aspect === cut.aspect
          ? cut.complete && !cut.empty ? { state: "ready" as const, why: null } : { state: "waiting" as const, why: MASTER_WAITING }
          : { state: "notbuilt" as const, why: ADAPT_WHY }),
      },
      ...GRID_SECONDS.map((seconds) => ({ aspect, seconds, name: deliverName(stem, aspect, seconds), state: "notbuilt" as const, why: ADAPT_WHY })),
    ],
  }));
}

/** "1 of 16 ready": the grid's own count, in the prototype's words. */
export function gridSummary(rows: readonly DeliverRow[]): string {
  const cells = rows.flatMap((r) => r.cells);
  return `${cells.filter((c) => c.state === "ready").length} of ${cells.length} ready`;
}

/** The lines under the grid (prototype), as display: the naming pattern, the format, the captions and the stems. */
export function deliverLines(stem: string): readonly (readonly [string, string])[] {
  return [
    ["Naming", NAMING_PATTERN(stem)],
    ["Format", "MP4 · H.264 / AAC, or WebM, made in your browser. ProRes isn’t built yet."],
    ["Captions", "Not built yet: no burned-in captions or SRT."],
    ["Stems", "One mixed WAV from Edit & Sound. Separate VO, music and SFX stems aren’t built yet."],
  ];
}

/* ── Languages ─────────────────────────────────────────────────────────── */

/** What one language needs, in the prototype's words: a dubbed voice, lip-sync and the on-screen text. */
export const LANGUAGE_PARTS = ["dubbed voice", "lip-sync", "on-screen text"] as const;
export const LANGUAGE_WHY = "Dubbing a finished cut, lip-sync and translated on-screen text have no engine or quote path yet, so no price is shown.";
/** The most languages a board keeps: the draft's schema takes no more (lib/workbench/studio-schema.ts › boardLanguages). */
export const MAX_LANGUAGES = 12;
/** Why another language cannot be added, or null. */
export const languageLimit = (count: number): string | null => (count >= MAX_LANGUAGES ? `A board holds up to ${MAX_LANGUAGES} languages. Remove one to add another.` : null);

/** The languages a person added, well formed and distinct (codes of the dubbing list). */
export function cleanLanguages(value: unknown, isKnown: (code: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((c): c is string => typeof c === "string" && isKnown(c)))].slice(0, MAX_LANGUAGES);
}

/* ── Mandatories ───────────────────────────────────────────────────────── */

/**
 * The brand mandatories check (prototype: Logo, End packshot, Legal line, Fonts · colours, VO tagline). No store holds a
 * brand's mandatories today (the Library tray's "Mandatories" kind is a stub too), so nothing can be checked or fixed:
 * the rows are shown as what will be checked, each "Not checked".
 */
export const MANDATORIES = ["Logo", "End packshot", "Legal line", "Fonts · colours", "VO tagline"] as const;
export const MANDATORIES_WHY = "Brand mandatories aren’t stored in Particl yet, so nothing is checked and there is nothing to fix.";

/* ── Export pack ───────────────────────────────────────────────────────── */

/** One platform's pack as the prototype words it. `ready`: whether today's exports can produce it (none can: each needs an adapted version). */
export type PackRow = { platform: string; spec: string; ready: boolean };
export const PACK_ROWS: readonly PackRow[] = [
  { platform: "Reels", spec: "MP4 · 9:16", ready: false },
  { platform: "Shorts", spec: "MP4 · 9:16", ready: false },
  { platform: "YouTube", spec: "MP4 · 16:9", ready: false },
  { platform: "Meta feed", spec: "MP4 · 4:5 · 1:1", ready: false },
];
export const PACK_WHY = "A platform’s pack needs its adapted version, which isn’t built yet.";
export const POST_DIRECTLY = { label: "Post directly", value: "Later · every post approved by a person" } as const;

/** What the Edit row of the pack really holds today (the editorial package), and what it does not. */
export const EDIT_HAS = "Premiere / Resolve XML · EDL · the cut’s source media";
export const EDIT_LACKS = "Separate audio stems, SRT captions and ProRes aren’t built yet.";
