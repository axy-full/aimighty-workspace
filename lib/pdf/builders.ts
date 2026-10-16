import { SHOT_COLUMNS, deckFacts, deckSections, shotListTitle, shotRows } from "@/lib/v12/ppm";
import { boardShots } from "@/lib/production/boards";
import { dubbingLanguageLabel } from "@/lib/workbench/dubbing-options";
import type { Project } from "@/lib/workbench/studio";
import { DEFAULT_PAGE, MAX_PAGES, KIND_LABEL, clampCell, oneLine, paginateFacts, paginateItems, paginateRows, paginateText, plain, textBudget, type DeckDoc, type DeckKind, type DeckPage, type PageSize } from "./deck";

/**
 * Builders: what each kind of deck gathers, turned into pages. They read only what the caller hands them (the server loads that
 * inside the caller's own workspace first). Nothing is invented: a section the source has nothing for gets no page.
 */
export type BoundPicture = { file: string; caption: string };
export type BuildOptions = {
  size?: PageSize;
  bleedMm?: number;
  title?: string;
  /** A workspace logo bound as an image file, for the cover. */
  logo?: string | null;
  /** Pictures to show, bound as image files, in order. */
  pictures?: readonly BoundPicture[];
  /** "15 Oct 2026": the cover's date; passed in so a deck is the same every time it is built. */
  date: string;
};

export class DeckTooLong extends Error {
  constructor(public pages: number) { super(`This deck would be ${pages} pages; the most is ${MAX_PAGES}.`); this.name = "DeckTooLong"; }
}

export const bullets = (heading: string, items: readonly string[], size: PageSize, eyebrow?: string): DeckPage[] =>
  paginateItems(items, size).map((chunk, i) => ({ type: "bullets", eyebrow, heading: i ? `${heading} (continued)` : heading, items: chunk }));
export const prose = (heading: string, paragraphs: readonly string[], size: PageSize, eyebrow?: string): DeckPage[] =>
  paginateText(paragraphs, textBudget(size)).map((chunk, i) => ({ type: "text", eyebrow, heading: i ? `${heading} (continued)` : heading, paragraphs: chunk }));
export const gallery = (heading: string, pictures: readonly BoundPicture[], eyebrow?: string): DeckPage[] => {
  const pages: DeckPage[] = [];
  for (let i = 0; i < pictures.length; i += 6) pages.push({ type: "images", eyebrow, heading: i ? `${heading} (continued)` : heading, items: pictures.slice(i, i + 6).map((p) => ({ file: p.file, caption: oneLine(p.caption, 80) })) });
  return pages;
};

function finish(kind: DeckKind, title: string, options: BuildOptions, pages: DeckPage[]): DeckDoc {
  if (pages.length > MAX_PAGES) throw new DeckTooLong(pages.length);
  const files = new Set<string>();
  for (const page of pages) {
    if (page.type === "cover" && page.logo) files.add(page.logo);
    if (page.type === "images") for (const item of page.items) files.add(item.file);
  }
  return { kind, title, size: options.size ?? DEFAULT_PAGE[kind], bleedMm: options.bleedMm ?? 0, pages, images: [...files] };
}

/* ── Treatment ───────────────────────────────────────────────────────── */

export type TreatmentSource = {
  title: string;
  logline: string;
  setup: Record<string, string>;
  scenes: { n: number; title: string; secs: number; prose: string }[];
  draft: number;
};

const SETUP_LABELS: Record<string, string> = {};
const label = (key: string) => SETUP_LABELS[key] ?? (key.charAt(0).toUpperCase() + key.slice(1).replace(/[_-]+/g, " "));

/** A treatment: the cover, the setup, one or more pages for each scene, then any pictures the caller chose. */
export function treatmentDoc(source: TreatmentSource, options: BuildOptions): DeckDoc {
  const size = options.size ?? DEFAULT_PAGE.treatment;
  const title = oneLine(options.title || source.title, 100) || "Untitled treatment";
  const pages: DeckPage[] = [{ type: "cover", title, subtitle: oneLine(source.logline, 200) || undefined, meta: [`Draft ${source.draft}`, options.date], ...(options.logo ? { logo: options.logo } : {}) }];
  const setup = Object.entries(source.setup).map(([k, v]) => [label(oneLine(k, 40)), oneLine(v, 240)] as [string, string]).filter(([k, v]) => k && v);
  paginateFacts(setup, size).forEach((rows, i) => pages.push({ type: "facts", eyebrow: "Setup", heading: i ? "Setup (continued)" : "The setup", rows }));
  for (const scene of source.scenes) {
    const words = [`Scene ${scene.n}`, scene.secs > 0 ? `${Math.round(scene.secs)} s` : ""].filter(Boolean).join(" · ");
    pages.push(...prose(oneLine(scene.title, 90) || `Scene ${scene.n}`, plain(scene.prose, 6000).split(/\n{2,}|\n/), size, words));
  }
  if (options.pictures?.length) pages.push(...gallery("Key frames", options.pictures, "Pictures"));
  return finish("treatment", title, options, pages);
}

/* ── Pitch deck ──────────────────────────────────────────────────────── */

export type PitchSource = {
  title: string;
  logline?: string;
  /** Who it is for: shown on the cover. */
  audience?: string;
  sections: { heading: string; paragraphs?: string[]; bullets?: string[] }[];
};

/** A pitch deck: the cover, then each section the caller wrote as text pages and lists, then any pictures the caller chose. */
export function pitchDoc(source: PitchSource, options: BuildOptions): DeckDoc {
  const size = options.size ?? DEFAULT_PAGE.pitch;
  const title = oneLine(options.title || source.title, 100) || "Untitled pitch";
  const pages: DeckPage[] = [{ type: "cover", title, subtitle: oneLine(source.logline, 200) || undefined, meta: [oneLine(source.audience, 120), options.date].filter(Boolean), ...(options.logo ? { logo: options.logo } : {}) }];
  for (const section of source.sections) {
    const heading = oneLine(section.heading, 90) || "Untitled";
    if (section.paragraphs?.length) pages.push(...prose(heading, section.paragraphs.map((p) => plain(p)), size));
    if (section.bullets?.length) pages.push(...bullets(section.paragraphs?.length ? `${heading} · points` : heading, section.bullets.map((b) => oneLine(b)).filter(Boolean), size));
  }
  if (options.pictures?.length) pages.push(...gallery("References", options.pictures));
  return finish("pitch", title, options, pages);
}

/* ── PPM deck ────────────────────────────────────────────────────────── */

export const PPM_COLUMN_PCT: Record<string, number> = { shot: 5, frame: 12, dur: 5, lens: 5, move: 8, cast: 9, location: 10, props: 8, wardrobe: 8, vo: 13, notes: 17 };
const SCRIPT_PAGES_MAX = 10;

/** A PPM deck from a board: the cover, the contents, the script, cast, places, props, pictures, then the shot list as a table. */
export function ppmDoc(project: Pick<Project, "name" | "script" | "scriptVersions" | "nodes" | "production" | "boardShotList">, options: BuildOptions): DeckDoc {
  const size = options.size ?? DEFAULT_PAGE.ppm;
  const title = oneLine(options.title || `${project.name || "Untitled board"} · PPM`, 100);
  const rows = shotRows(project.production?.beats, project.boardShotList);
  const facts = { ...deckFacts(project), shots: rows.length };
  const sections = deckSections(facts, Boolean(options.logo));
  const pages: DeckPage[] = [{ type: "cover", title, meta: [options.date], ...(options.logo ? { logo: options.logo } : {}) }];
  /* The on-screen lines say "editable table" and "Your logo"; on paper each says what is in this PDF. */
  const said = (n: number, line: string) => (n === 1 ? (options.logo ? "Your logo and the date" : "The board’s name and the date") : n === 8 ? line.replace(" · editable table", "") : (n === 6 || n === 7) && options.pictures?.length ? `${options.pictures.length} ${options.pictures.length === 1 ? "picture" : "pictures"} below` : line);
  pages.push(...bullets("What this deck holds", sections.map((s) => `${s.n}. ${s.title}: ${said(s.n, s.line)}`), size, "Contents"));
  if (facts.script) {
    const script = prose("Script", plain(facts.script, 40_000).split(/\n{2,}|\n/), size, "Section 2");
    pages.push(...script.slice(0, SCRIPT_PAGES_MAX));
    if (script.length > SCRIPT_PAGES_MAX) pages.push({ type: "text", eyebrow: "Section 2", heading: "Script (cut here)", paragraphs: [`The script goes on for ${script.length - SCRIPT_PAGES_MAX} more pages. It is whole on the board.`] });
  }
  const listed = (heading: string, items: string[], n: string) => { if (items.length) pages.push(...bullets(heading, items.map((x) => oneLine(x)), size, n)); };
  listed("Cast", facts.cast, "Section 3");
  listed("Locations", facts.locations, "Section 4");
  listed("Wardrobe and props", [...facts.wardrobe, ...facts.props], "Section 5");
  if (options.pictures?.length) pages.push(...gallery("Look references and storyboard", options.pictures, "Sections 6 and 7"));
  if (rows.length) {
    const columns = SHOT_COLUMNS.map((c) => ({ label: c.label, pct: PPM_COLUMN_PCT[c.field] ?? 8 }));
    const cells = rows.map((r) => SHOT_COLUMNS.map((c, i) => (c.field === "shot" ? String(r.index) : clampCell(oneLine(r[c.field], 200), columns[i].pct))));
    const chunks = paginateRows(columns, cells, size);
    chunks.forEach((chunk, i) => pages.push({ type: "table", eyebrow: "Section 8", heading: i ? `Shot list (continued) · ${shotListTitle(rows)}` : `Shot list · ${shotListTitle(rows)}`, columns, rows: chunk }));
  }
  return finish("ppm", title, options, pages);
}

export const kindLabel = (kind: DeckKind) => KIND_LABEL[kind];

/* ── Film deck: one deck, two covers ─────────────────────────────────── */

export const FILM_COVERS = ["treatment", "pitch"] as const;
export type FilmCover = (typeof FILM_COVERS)[number];
/** The most pictures a film deck picks for itself, so a caller's own still have room (MAX_IMAGES is 24). */
export const FILM_PICTURES = 12;

/** The storyboard's own pictures, in shot order: each frame's latest take, as `{ take, caption }`. Which of them the caller may read is decided when they are bound. */
export function filmPictureHandles(project: Pick<Project, "production">): { take: string; caption: string }[] {
  const frames = project.production?.boards?.frames ?? {};
  const out: { take: string; caption: string }[] = [];
  for (const shot of boardShots(project.production?.beats)) {
    const take = frames[shot.id]?.takes?.at(-1)?.genId;
    if (take && /^[A-Za-z0-9_-]{1,120}$/.test(take)) out.push({ take, caption: `Shot ${shot.number} · ${shot.shot.framing}` });
    if (out.length >= FILM_PICTURES) break;
  }
  return out;
}

/**
 * A film deck from a board: one deck with a choice of cover. The Treatment cover is quiet and names the draft; the Pitch cover is
 * bold and names who it is for. Every page after it is the same: the idea, the brief's facts, the script, cast, places and props,
 * the look and the storyboard, the shot list and the versions the film is made in.
 */
export function filmDoc(project: Pick<Project, "name" | "brief" | "script" | "scriptVersions" | "nodes" | "production" | "boardShotList" | "audience" | "deliverables" | "direction" | "aspect" | "fps" | "boardLanguages">, options: BuildOptions & { cover: FilmCover }): DeckDoc {
  const size = options.size ?? DEFAULT_PAGE.film;
  const title = oneLine(options.title || project.name || "Untitled film", 100);
  const rows = shotRows(project.production?.beats, project.boardShotList);
  const facts = deckFacts(project);
  const idea = oneLine(project.brief, 220);
  const cover: DeckPage = options.cover === "pitch"
    ? { type: "cover", style: "pitch", eyebrow: "Pitch deck", title, subtitle: idea || undefined, meta: [oneLine(project.audience, 120), options.date].filter(Boolean), ...(options.logo ? { logo: options.logo } : {}) }
    : { type: "cover", style: "treatment", eyebrow: "Treatment", title, subtitle: idea || undefined, meta: [`${rows.length} ${rows.length === 1 ? "shot" : "shots"}`, options.date].filter((x) => !x.startsWith("0 ")), ...(options.logo ? { logo: options.logo } : {}) };
  const pages: DeckPage[] = [cover];
  if (project.brief.trim()) pages.push(...prose("The idea", plain(project.brief, 4000).split(/\n{2,}|\n/), size));
  const languages = ["English", ...(project.boardLanguages ?? []).filter((c) => c !== "en").map((c) => dubbingLanguageLabel(c))];
  const setup = ([["Audience", project.audience], ["Deliverables", project.deliverables], ["Direction", project.direction], ["Format", `${project.aspect} · ${project.fps} fps`], ["Versions", languages.join(" · ")]] as [string, string][])
    .map(([k, v]) => [k, oneLine(v, 240)] as [string, string]).filter(([, v]) => v);
  paginateFacts(setup, size).forEach((chunk, i) => pages.push({ type: "facts", eyebrow: "Brief", heading: i ? "The brief (continued)" : "The brief", rows: chunk }));
  if (facts.script) {
    const script = prose("Script", plain(facts.script, 40_000).split(/\n{2,}|\n/), size);
    pages.push(...script.slice(0, SCRIPT_PAGES_MAX));
    if (script.length > SCRIPT_PAGES_MAX) pages.push({ type: "text", heading: "Script (cut here)", paragraphs: [`The script goes on for ${script.length - SCRIPT_PAGES_MAX} more pages. It is whole on the board.`] });
  }
  const listed = (heading: string, items: string[]) => { if (items.length) pages.push(...bullets(heading, items.map((x) => oneLine(x)), size)); };
  listed("Cast", facts.cast);
  listed("Locations", facts.locations);
  listed("Props", [...facts.wardrobe, ...facts.props]);
  if (options.pictures?.length) pages.push(...gallery("Look and storyboard", options.pictures));
  if (rows.length) {
    const columns = SHOT_COLUMNS.map((c) => ({ label: c.label, pct: PPM_COLUMN_PCT[c.field] ?? 8 }));
    const cells = rows.map((r) => SHOT_COLUMNS.map((c, i) => (c.field === "shot" ? String(r.index) : clampCell(oneLine(r[c.field], 200), columns[i].pct))));
    paginateRows(columns, cells, size).forEach((chunk, i) => pages.push({ type: "table", heading: i ? `Shot list (continued) · ${shotListTitle(rows)}` : `Shot list · ${shotListTitle(rows)}`, columns, rows: chunk }));
  }
  return finish("film", title, options, pages);
}
