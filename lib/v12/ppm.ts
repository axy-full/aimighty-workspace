/**
 * The PPM deck and its shot list in the new interface (docs/redesign/inventory.md § 6.7; prototype L604, L587): what a
 * pre-production meeting deck gathers from a board, and the editable shot list kept in the board's draft. Pure: no React
 * (tests/unit/v12-ppm.spec.ts).
 *
 * The deck's sections read what the board holds (script, cast, locations, props, looks, storyboard, shot list); nothing
 * is invented, and a section the board has nothing for says so. The shot list's rows start from the beat sheet
 * (lib/production/beats.ts) and a person's edits to any cell are kept beside it as `boardShotList` in the project's
 * draft, keyed by the beat sheet's own shot id: no table, no copy of the beat sheet.
 */
import type { BeatSheet } from "@/lib/production/beats";
import type { Project } from "@/lib/workbench/studio";
import { csvCell } from "./csv";

/** What a person may write in a cell (the draft's field: lib/workbench/studio-schema.ts › boardShotList). */
export const SHOT_FIELDS = ["frame", "dur", "lens", "move", "cast", "location", "props", "wardrobe", "vo", "notes"] as const;
export type ShotField = (typeof SHOT_FIELDS)[number];
export type ShotEdits = Partial<Record<ShotField, string>>;
export type SavedShotList = Record<string, ShotEdits>;
export const CELL_MAX = 200;
export const SHOTS_MAX = 400;

/** The table's columns in the lead's order: shot, frame, duration, lens, camera move, cast, location, props, wardrobe, VO / dialogue, notes. */
export const SHOT_COLUMNS: readonly { field: ShotField | "shot"; label: string }[] = [
  { field: "shot", label: "Shot" }, { field: "frame", label: "Frame" }, { field: "dur", label: "Dur" }, { field: "lens", label: "Lens" },
  { field: "move", label: "Camera move" }, { field: "cast", label: "Cast" }, { field: "location", label: "Location" }, { field: "props", label: "Props" },
  { field: "wardrobe", label: "Wardrobe" }, { field: "vo", label: "VO / dialogue" }, { field: "notes", label: "Notes" },
];

export type ShotRow = { id: string; index: number; scene: string } & Record<ShotField, string>;

const text = (v: unknown, max = CELL_MAX) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const seconds = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} s` : "");

/** The rows: the beat sheet's shots in order, each cell the person's edit when there is one, else what the sheet says. */
export function shotRows(sheet: BeatSheet | null | undefined, saved: SavedShotList | null | undefined): ShotRow[] {
  const rows: ShotRow[] = [];
  for (const scene of sheet?.scenes ?? []) {
    for (const shot of scene.shots) {
      const own = saved?.[shot.id] ?? {};
      const pick = (field: ShotField, fallback: string) => (own[field] !== undefined ? text(own[field]) : fallback);
      rows.push({
        id: shot.id, index: rows.length + 1, scene: scene.heading,
        frame: pick("frame", text(shot.framing) || text(shot.description, 80)), dur: pick("dur", seconds(shot.duration)), lens: pick("lens", ""),
        move: pick("move", text(shot.movement)), cast: pick("cast", scene.characters.join(", ")), location: pick("location", scene.locations.join(", ")),
        props: pick("props", scene.props.join(", ")), wardrobe: pick("wardrobe", ""), vo: pick("vo", text(shot.sound)), notes: pick("notes", text(shot.lighting)),
      });
    }
  }
  return rows;
}

/** One cell edited: the saved list with that cell set (an empty edit that equals the sheet's own is kept as typed: empty means empty). */
export function withShotEdit(saved: SavedShotList | null | undefined, shotId: string, field: ShotField, value: string): SavedShotList {
  const next: SavedShotList = { ...(saved ?? {}) };
  next[shotId] = { ...(next[shotId] ?? {}), [field]: text(value) };
  /* Bounded: the most shots a list keeps edits for. */
  const keys = Object.keys(next);
  if (keys.length > SHOTS_MAX) for (const k of keys.slice(0, keys.length - SHOTS_MAX)) delete next[k];
  return next;
}

/** "8 shots · 0:30": the table's title line. Length is the sum of the durations that are numbers. */
export function shotListTitle(rows: readonly ShotRow[]): string {
  const total = rows.reduce((n, r) => n + (Number.parseFloat(r.dur) || 0), 0);
  const clock = `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, "0")}`;
  return `${rows.length} ${rows.length === 1 ? "shot" : "shots"}${total > 0 ? ` · ${clock}` : ""}`;
}

/** The shot list as a CSV a spreadsheet opens (cells that start with a formula character are quoted as text). */
export function shotListCsv(rows: readonly ShotRow[]): string {
  const head = SHOT_COLUMNS.map((c) => csvCell(c.label)).join(",");
  const lines = rows.map((r) => SHOT_COLUMNS.map((c) => csvCell(c.field === "shot" ? String(r.index) : r[c.field])).join(","));
  return [head, ...lines].join("\r\n") + "\r\n";
}

/** The file name for a download of the deck's parts. */
export const shotListFile = (stem: string) => `${stem}_shot-list.csv`;

/* ── The deck's sections ──────────────────────────────────────────────── */

export type DeckFacts = {
  /** Words of the script as the board keeps them, or "". */
  script: string;
  scriptVersions: number;
  cast: string[];
  locations: string[];
  props: string[];
  wardrobe: string[];
  looks: number;
  frames: number;
  shots: number;
};
export type DeckSection = { n: number; title: string; line: string; empty: boolean };

const listWords = (items: readonly string[], one: string, many: string, max = 4) => {
  if (!items.length) return "";
  const shown = items.slice(0, max).join(", ");
  return `${items.length} ${items.length === 1 ? one : many} · ${shown}${items.length > max ? "…" : ""}`;
};

/** The eight sections of § 6.7, each with what this board holds for it. */
export function deckSections(f: DeckFacts, hasLogo: boolean): DeckSection[] {
  const line = (words: string, none: string) => ({ line: words || none, empty: !words });
  return [
    { n: 1, title: "Cover", ...{ line: hasLogo ? "Your logo · the date" : "The board’s name · the date", empty: false } },
    { n: 2, title: "Script", ...line(f.script ? `${f.scriptVersions > 1 ? `v${f.scriptVersions} · ` : ""}${f.script.split(/\s+/).filter(Boolean).length.toLocaleString("en-US")} words` : "", "No script yet") },
    { n: 3, title: "Cast", ...line(listWords(f.cast, "character", "characters"), "No cast yet") },
    { n: 4, title: "Locations", ...line(listWords(f.locations, "location", "locations"), "No locations yet") },
    { n: 5, title: "Wardrobe and props", ...line(listWords([...f.wardrobe, ...f.props], "item", "items"), "None yet") },
    { n: 6, title: "Look references", ...line(f.looks ? `${f.looks} ${f.looks === 1 ? "look" : "looks"}` : "", "No looks yet") },
    { n: 7, title: "Storyboard", ...line(f.frames ? `${f.frames} ${f.frames === 1 ? "frame" : "frames"}` : "", "No frames yet") },
    { n: 8, title: "Shot list", ...line(f.shots ? `${f.shots} ${f.shots === 1 ? "shot" : "shots"} · editable table` : "", "No shots yet") },
  ];
}

/** The deck's exports (prototype), free; which exist today, and why the rest do not. */
export const DECK_EXPORTS = [
  { id: "deck", label: "PPM deck PDF", built: false, why: "Particl doesn’t make PDFs yet." },
  { id: "csv", label: "Shot list CSV", built: true, why: null },
  { id: "pdf", label: "Shot list PDF", built: false, why: "Particl doesn’t make PDFs yet." },
  { id: "animatic", label: "Animatic MP4", built: false, why: "The animatic isn’t built yet." },
] as const;

/**
 * What this board holds for the deck, read from its own draft: no sample, no guess. The cast, places and things are the cards
 * the board draws for them (a node's reference kind) plus the production's own cast entries and the beat sheet's lists.
 * Wardrobe is not stored anywhere yet, so it is empty.
 */
export function deckFacts(project: Pick<Project, "script" | "scriptVersions" | "nodes" | "production">): DeckFacts {
  const entries = project.production?.cast?.entries ?? [];
  const sheet = project.production?.beats;
  const unique = (list: readonly string[]) => [...new Set(list.map((x) => x.trim()).filter(Boolean))];
  const named = (kind: string) => project.nodes.filter((n) => n.refKind === kind).map((n) => n.title);
  const frames = Object.values(project.production?.boards?.frames ?? {}).filter((f) => (f?.takes?.length ?? 0) > 0).length;
  return {
    script: project.script ?? "",
    scriptVersions: (project.scriptVersions?.length ?? 0) + (project.script ? 1 : 0),
    cast: unique([...named("cast"), ...entries.filter((e) => e.kind === "character").map((e) => e.name)]),
    locations: unique([...named("environment"), ...(sheet?.scenes ?? []).flatMap((s) => s.locations), ...entries.filter((e) => e.kind === "element" && e.category === "environment").map((e) => e.name)]),
    props: unique([...named("element"), ...(sheet?.scenes ?? []).flatMap((s) => s.props), ...entries.filter((e) => e.kind === "element" && e.category !== "environment").map((e) => e.name)]),
    wardrobe: [],
    looks: project.nodes.filter((n) => n.type === "moodboard").length,
    frames,
    shots: (sheet?.scenes ?? []).reduce((n, s) => n + s.shots.length, 0),
  };
}

/** The deck's meta line (prototype: "Draft · 8 sections"): how many of its sections have something in them, never more than there are. */
export function deckMeta(sections: readonly DeckSection[]): string {
  const filled = sections.filter((s) => !s.empty).length;
  return `Draft · ${filled} ${filled === 1 ? "section" : "sections"}`;
}
