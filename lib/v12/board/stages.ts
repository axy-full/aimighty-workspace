/**
 * A board's stages in the new interface (docs/redesign/inventory.md § 6.1, § 6.2, § 6.4; docs/redesign-plan.md P2-a).
 *
 * Today's board is one canvas cut into regions (lib/board/regions.ts). The new interface shows one stage at a time: a
 * stage is a slice of today's cards (by region, and for Script, Cast and Elements by what the card is), so the stage
 * canvas draws exactly the cards today's board draws, nothing invented.
 *
 * Board kinds: today's three (lib/board/kind.ts). A Studio board is the prototype's Film; Ads and Social keep their own
 * rails, one stage per region, until their own P6 items. Pre-vis has no data today and is not offered.
 *
 * What a person changes on the rail (order, names, skipped stages, added or removed stages) is kept in the project's
 * draft as `boardStages` (lib/workbench/studio-schema.ts): an optional field of the draft JSON, saved and merged like the
 * rest of the draft. No database change.
 *
 * Pure: no React.
 */
import { regionStatus, type RailEntry, type RegionStatus } from "@/lib/board/regions";
import type { BoardCard, BoardKind, RegionId } from "@/lib/board/types";

/** One stage as saved in the draft. Absent list: the kind's own rail. */
export type SavedStage = { id: string; label?: string; skipped?: boolean; custom?: boolean };

/** A stage as the rail draws it. */
export type Stage = { id: string; label: string; skipped: boolean; custom: boolean; regions: readonly RegionId[] };

/** What a built-in stage draws: the regions its cards sit in, and for a shared region which of them. */
type StageDef = { id: string; label: string; regions: readonly RegionId[]; holds?: (card: BoardCard) => boolean };

const variantOf = (card: BoardCard) => (card.data as { variant?: unknown } | null)?.variant;
const castVariant = (card: BoardCard, want: "people" | "things") => {
  if (card.kind === "group") return true;
  const v = variantOf(card);
  return want === "people" ? v === "cast" : v === "environment" || v === "element";
};

/** The prototype's Film rail (§ 6.1) over today's Studio regions. Looks travel with the Brief, as references. */
export const FILM_STAGES: readonly StageDef[] = [
  { id: "brief", label: "Brief", regions: ["brief", "looks"] },
  /* Nothing on today's board draws the script (it is read in the brief's tools); the stage is empty until P2's stage contents. */
  { id: "script", label: "Script", regions: [] },
  { id: "cast", label: "Cast", regions: ["cast"], holds: (card) => castVariant(card, "people") },
  { id: "elements", label: "Elements", regions: ["cast"], holds: (card) => castVariant(card, "things") },
  { id: "storyboard", label: "Storyboard", regions: ["storyboard"] },
  { id: "shots", label: "Shots", regions: ["shots", "next", "made"] },
  { id: "cut", label: "Cut", regions: ["cut"] },
  { id: "deliver", label: "Deliver", regions: ["deliver"] },
];

/** The rail's kind label (§ 6.2), by today's board kind. */
export const KIND_LABEL: Record<BoardKind, string> = { studio: "Film", ads: "Campaign", social: "Social · clips" };

/** The stage a board opens on (§ 6.1): Film opens on Storyboard; another kind on its first stage. */
export const OPENS_ON: Partial<Record<BoardKind, string>> = { studio: "storyboard" };

/** "+ Stage" presets (§ 6.1), in the popover's order. A preset stage is a custom stage with the preset's name. */
export const STAGE_PRESETS = [
  { id: "moodboard", label: "Moodboard", line: "before the storyboard" },
  { id: "recce", label: "Recce", line: "locations to check" },
  { id: "client-review", label: "Client review", line: "a share link, no sign-in" },
  { id: "animatic", label: "Animatic", line: "the timed storyboard" },
] as const;

/** The built-in stages of a kind: Film's, or one per region of the kind's own rail. */
export function builtInStages(kind: BoardKind, rail: readonly RailEntry[]): readonly StageDef[] {
  return kind === "studio" ? FILM_STAGES : rail.map((entry) => ({ id: entry.id, label: entry.label, regions: [entry.id] }));
}

const LABEL_MAX = 40;
const cleanLabel = (label: unknown): string | null => {
  const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return text || null;
};

/** The rail: the saved list when there is one (unknown built-in ids dropped), else the kind's own. */
export function stagesOf(kind: BoardKind, rail: readonly RailEntry[], saved: readonly SavedStage[] | null | undefined): Stage[] {
  const defs = builtInStages(kind, rail);
  const byId = new Map(defs.map((d) => [d.id, d]));
  if (!saved?.length) return defs.map((d) => ({ id: d.id, label: d.label, skipped: false, custom: false, regions: d.regions }));
  const seen = new Set<string>();
  const out: Stage[] = [];
  for (const s of saved) {
    if (!s || typeof s.id !== "string" || seen.has(s.id)) continue;
    const def = byId.get(s.id);
    if (!def && !s.custom) continue;
    seen.add(s.id);
    out.push({ id: s.id, label: cleanLabel(s.label) ?? def?.label ?? "New stage", skipped: Boolean(s.skipped), custom: !def, regions: def?.regions ?? [] });
  }
  return out;
}

/** The cards a stage draws: its regions' cards, filtered by what the stage holds. A custom stage draws none yet. */
export function stageCards(stage: Pick<Stage, "id" | "regions">, cards: readonly BoardCard[], kind: BoardKind, rail: readonly RailEntry[]): BoardCard[] {
  const def = builtInStages(kind, rail).find((d) => d.id === stage.id);
  if (!def) return [];
  const regions = new Set<RegionId | null>(def.regions);
  return cards.filter((card) => regions.has(card.region) && (!def.holds || def.holds(card)));
}

/** A stage's marker and hover summary, rolled up from its cards (today's rail status rules). */
export function stageStatus(stage: Pick<Stage, "id" | "regions">, cards: readonly BoardCard[], kind: BoardKind, rail: readonly RailEntry[]): RegionStatus {
  /* A group frame shared by two stages (Cast and Elements share today's cast frame) speaks for both: there, only the
     stage's own cards count. Elsewhere the frame's state is the region's (the storyboard's "approve to make shots"). */
  const shared = Boolean(builtInStages(kind, rail).find((d) => d.id === stage.id)?.holds);
  return regionStatus(stageCards(stage, cards, kind, rail).filter((card) => card.kind !== "group" || (!shared && card.state !== "empty")));
}

/** The stage to show: the address's, if the rail has it; else the kind's opening stage; else the first. */
export function currentStage(stages: readonly Stage[], asked: string | null | undefined, kind: BoardKind): Stage | null {
  return stages.find((s) => s.id === asked) ?? stages.find((s) => s.id === OPENS_ON[kind]) ?? stages[0] ?? null;
}

/* ── Rail edits: each returns the whole saved list, which the draft keeps ─────────────────────────── */

const toSaved = (stages: readonly Stage[]): SavedStage[] =>
  stages.map((s) => ({ id: s.id, ...(s.custom || s.label !== builtInLabel(s.id) ? { label: s.label } : {}), ...(s.skipped ? { skipped: true } : {}), ...(s.custom ? { custom: true } : {}) }));
const builtInLabel = (id: string) => FILM_STAGES.find((d) => d.id === id)?.label;

export function renameStage(stages: readonly Stage[], id: string, label: string): SavedStage[] {
  const name = cleanLabel(label);
  return toSaved(stages.map((s) => (s.id === id && name ? { ...s, label: name } : s)));
}
export function skipStage(stages: readonly Stage[], id: string, skipped: boolean): SavedStage[] {
  return toSaved(stages.map((s) => (s.id === id ? { ...s, skipped } : s)));
}
export function removeStage(stages: readonly Stage[], id: string): SavedStage[] {
  return toSaved(stages.filter((s) => s.id !== id));
}
/** Moves a stage to `index` (0-based, in the list without it). */
export function moveStage(stages: readonly Stage[], id: string, index: number): SavedStage[] {
  const from = stages.findIndex((s) => s.id === id);
  if (from < 0) return toSaved(stages);
  const rest = stages.filter((s) => s.id !== id);
  const at = Math.max(0, Math.min(rest.length, Math.round(index)));
  return toSaved([...rest.slice(0, at), stages[from], ...rest.slice(at)]);
}
/** Adds a stage after `after` (or at the end): a preset by its name, or "New stage". Returns the list and the new id. */
export function addStage(stages: readonly Stage[], after: string | null, label: string, makeId: () => string): { saved: SavedStage[]; id: string } {
  const id = `custom-${makeId()}`;
  const fresh: Stage = { id, label: cleanLabel(label) ?? "New stage", skipped: false, custom: true, regions: [] };
  const at = after ? stages.findIndex((s) => s.id === after) + 1 : stages.length;
  const next = [...stages.slice(0, at > 0 ? at : stages.length), fresh, ...stages.slice(at > 0 ? at : stages.length)];
  return { saved: toSaved(next), id };
}

/* ── The stage header (§ 6.4) ─────────────────────────────────────────────────────────────────────── */

/**
 * The one filled primary, only on the stage where its action lives (§ 6.4, L836), from what today's board can do:
 *  - Cast: "Review the cast" while a cast card waits for a person (it selects the first such card).
 *  - Storyboard and Shots: "Review the plan" while Atomik's plan waits for approval (it selects the plan card, whose own
 *    Approve carries the plan's price; the header never approves or spends).
 * The prototype's priced primaries (Approve 8 shots · 128 cr, Make social cuts · ~9 cr) need actions today's board
 * does not have from a header; they come with the stage contents.
 */
export type StagePrimary = { label: string; card: string };
export function stagePrimary(stage: Pick<Stage, "id"> | null, cards: readonly BoardCard[], kind: BoardKind): StagePrimary | null {
  if (!stage || kind !== "studio") return null;
  if (stage.id === "cast") {
    const waiting = cards.find((c) => c.region === "cast" && c.kind !== "group" && variantOf(c) === "cast" && c.state === "needs");
    return waiting ? { label: "Review the cast", card: waiting.id } : null;
  }
  if (stage.id === "storyboard" || stage.id === "shots") {
    const plan = cards.find((c) => c.kind === "plan" && c.state === "needs");
    return plan ? { label: "Review the plan", card: plan.id } : null;
  }
  return null;
}

/** "Shot 4", "3 cards": the selection as the breadcrumb's last crumb. */
export function selectionCrumb(titles: readonly string[]): string | null {
  if (!titles.length) return null;
  if (titles.length === 1) return titles[0];
  return `${titles.length} cards`;
}

/** The empty stage (prototype L616, verbatim where the stage has one). `ask`: the custom stage's one action. */
export type StageEmpty = { title: string; line: string; ask?: true };
const EMPTY: Record<string, StageEmpty> = {
  cut: { title: "Nothing to cut yet", line: "Approved takes land here in order, with a timeline, music, voice and captions." },
  deliver: { title: "Nothing to deliver yet", line: "The spec check and the master appear once there is a cut. Rendering is free." },
  shots: { title: "Shots wait for the cast and the storyboard", line: "Approve the plan on the Storyboard and the shots start here." },
  moodboard: { title: "Moodboard", line: "Drop references from the Library, or ask Atomik to gather a mood from the brief." },
  recce: { title: "Recce", line: "Locations to check before the shoot. Drop photos here." },
  "client-review": { title: "Client review", line: "Share a link; the client approves and comments without signing in." },
  animatic: { title: "Animatic", line: "The storyboard cut to the script’s timings." },
};
export function stageEmpty(stage: Pick<Stage, "id" | "label" | "custom">): StageEmpty {
  if (stage.custom) {
    const preset = STAGE_PRESETS.find((p) => p.label === stage.label);
    if (preset && EMPTY[preset.id]) return EMPTY[preset.id];
    return { title: stage.label, line: "A stage you added. Drop cards here from the Library, or ask for it in the bar.", ask: true };
  }
  return EMPTY[stage.id] ?? { title: `Nothing on ${stage.label} yet`, line: "Ask Atomik in the bar, or drop cards here from the Library." };
}
