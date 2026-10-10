/**
 * A board's stages in the new interface (docs/redesign/inventory.md § 6.1, § 6.2, § 6.4; docs/redesign-plan.md P2-a).
 *
 * Today's board is one canvas cut into regions (lib/board/regions.ts). The new interface shows one stage at a time: a
 * stage is a slice of today's cards (by region, and for Script, Cast and Elements by what the card is), so the stage
 * canvas draws exactly the cards today's board draws, nothing invented.
 *
 * Board kinds (lib/v12/board/kinds.ts): Film and Pre-vis sit over today's Studio board, Campaign over Ads, and Social
 * (narrated or clips) over Social. Each kind's rail is its own list of stages over that board's regions; a stage with no
 * region today (Script, Voice, Moments, …) is empty until its stage contents are built, and every region of a board
 * belongs to some stage, so no card disappears.
 *
 * What a person changes on the rail (order, names, skipped stages, added or removed stages) is kept in the project's
 * draft as `boardStages` (lib/workbench/studio-schema.ts): an optional field of the draft JSON, saved and merged like the
 * rest of the draft. No database change.
 *
 * Pure: no React.
 */
import { regionStatus, type RegionStatus } from "@/lib/board/regions";
import type { BoardCard, RegionId } from "@/lib/board/types";
import { FLAVOR_BOARD, FLAVOR_LABEL, type Flavor } from "./kinds";

/** One stage as saved in the draft. Absent list: the kind's own rail. */
export type SavedStage = { id: string; label?: string; skipped?: boolean; custom?: boolean };

/** A stage as the rail draws it. */
/** `builtIn`: the kind's own name for the stage (null for one a person added); a label that differs is a rename. */
export type Stage = { id: string; label: string; builtIn: string | null; skipped: boolean; custom: boolean; regions: readonly RegionId[] };

/** What a built-in stage draws: the regions its cards sit in, and for a shared region which of them. */
type StageDef = { id: string; label: string; regions: readonly RegionId[]; holds?: (card: BoardCard) => boolean };

const variantOf = (card: BoardCard) => (card.data as { variant?: unknown } | null)?.variant;
const castVariant = (card: BoardCard, want: "people" | "things") => {
  if (card.kind === "group") return true;
  const v = variantOf(card);
  return want === "people" ? v === "cast" : v === "environment" || v === "element";
};

/** Film's rail (§ 6.1) over today's Studio regions. Looks travel with the Brief, as references. */
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

/** Pre-vis: the same data as Film up to the storyboard; the animatic is the timed shots and cut, the PPM deck the delivery. */
export const PREVIS_STAGES: readonly StageDef[] = [
  ...FILM_STAGES.slice(0, 5),
  { id: "animatic", label: "Animatic", regions: ["shots", "next", "made", "cut"] },
  { id: "ppm-deck", label: "PPM deck", regions: ["deliver"] },
];

/** Campaign over Ads' regions: Look is the brand kit, Variants the hooks and the ads made from them. */
export const CAMPAIGN_STAGES: readonly StageDef[] = [
  { id: "product", label: "Product", regions: ["product"] },
  { id: "look", label: "Look", regions: ["brand"] },
  { id: "formats", label: "Formats", regions: ["formats"] },
  { id: "variants", label: "Variants", regions: ["hooks", "ads"] },
  { id: "deliver", label: "Deliver", regions: ["adapt", "deliver", "next", "made"] },
];

/** Social, narrated: today's Social board has no narration yet, so its source rides with the Script and Voice is empty. */
export const NARRATED_STAGES: readonly StageDef[] = [
  { id: "hook", label: "Hook", regions: ["hooks"] },
  { id: "script", label: "Script", regions: ["source"] },
  { id: "scenes", label: "Scenes", regions: ["clips"] },
  { id: "voice", label: "Voice", regions: [] },
  { id: "captions", label: "Captions", regions: ["effects"] },
  { id: "deliver", label: "Deliver", regions: ["posts", "next", "made"] },
];

/** Social, clips: Moments are read from the source's own card today, so the stage is empty until its contents are built. */
export const CLIPS_STAGES: readonly StageDef[] = [
  { id: "source", label: "Source", regions: ["source"] },
  { id: "moments", label: "Moments", regions: [] },
  { id: "clips", label: "Clips", regions: ["clips", "hooks"] },
  { id: "captions", label: "Captions", regions: ["effects"] },
  { id: "deliver", label: "Deliver", regions: ["posts", "next", "made"] },
];

const RAILS: Record<Flavor, readonly StageDef[]> = { film: FILM_STAGES, previs: PREVIS_STAGES, campaign: CAMPAIGN_STAGES, narrated: NARRATED_STAGES, clips: CLIPS_STAGES };

/** The rail's kind label (§ 6.2), by kind. */
export const KIND_LABEL = FLAVOR_LABEL;

/** The stage a board opens on (§ 6.1). */
export const OPENS_ON: Record<Flavor, string> = { film: "storyboard", previs: "ppm-deck", campaign: "formats", narrated: "scenes", clips: "clips" };

/** "+ Stage" presets (§ 6.1), in the popover's order. A preset stage is a custom stage with the preset's name. */
export const STAGE_PRESETS = [
  { id: "moodboard", label: "Moodboard", line: "before the storyboard" },
  { id: "recce", label: "Recce", line: "locations to check" },
  { id: "client-review", label: "Client review", line: "a share link, no sign-in" },
  { id: "animatic", label: "Animatic", line: "the timed storyboard" },
] as const;

/** The built-in stages of a kind. */
export const builtInStages = (flavor: Flavor): readonly StageDef[] => RAILS[flavor];

const LABEL_MAX = 40;
const cleanLabel = (label: unknown): string | null => {
  const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return text || null;
};

/** The rail: the saved list when there is one (unknown built-in ids dropped), else the kind's own. */
export function stagesOf(flavor: Flavor, saved: readonly SavedStage[] | null | undefined): Stage[] {
  const defs = builtInStages(flavor);
  const byId = new Map(defs.map((d) => [d.id, d]));
  if (!saved?.length) return defs.map((d) => ({ id: d.id, label: d.label, builtIn: d.label, skipped: false, custom: false, regions: d.regions }));
  const seen = new Set<string>();
  const out: Stage[] = [];
  for (const s of saved) {
    if (!s || typeof s.id !== "string" || seen.has(s.id)) continue;
    const def = byId.get(s.id);
    if (!def && !s.custom) continue;
    seen.add(s.id);
    out.push({ id: s.id, label: cleanLabel(s.label) ?? def?.label ?? "New stage", builtIn: def?.label ?? null, skipped: Boolean(s.skipped), custom: !def, regions: def?.regions ?? [] });
  }
  return out;
}

/** The cards a stage draws: its regions' cards, filtered by what the stage holds. A custom stage draws none yet. */
export function stageCards(stage: Pick<Stage, "id" | "regions">, cards: readonly BoardCard[], flavor: Flavor): BoardCard[] {
  const def = builtInStages(flavor).find((d) => d.id === stage.id);
  if (!def) return [];
  const regions = new Set<RegionId | null>(def.regions);
  return cards.filter((card) => regions.has(card.region) && (!def.holds || def.holds(card)));
}

/**
 * The board's free cards: notes, labels and media dropped, attached or uploaded onto the canvas. They belong to the board, not
 * to one stage (no region of today's board holds them), so every stage's canvas draws them where they were put and none is
 * hidden. They are never counted in a stage's status or its empty state.
 */
export const freeCards = (cards: readonly BoardCard[]): BoardCard[] => cards.filter((card) => card.region === null);

/** A stage's marker and hover summary, rolled up from its cards (today's rail status rules). */
export function stageStatus(stage: Pick<Stage, "id" | "regions">, cards: readonly BoardCard[], flavor: Flavor): RegionStatus {
  /* A group frame shared by two stages (Cast and Elements share today's cast frame) speaks for both: there, only the
     stage's own cards count. Elsewhere the frame's state is the region's (the storyboard's "approve to make shots"). */
  const shared = Boolean(builtInStages(flavor).find((d) => d.id === stage.id)?.holds);
  return regionStatus(stageCards(stage, cards, flavor).filter((card) => card.kind !== "group" || (!shared && card.state !== "empty")));
}

/** The stage to show: the address's, if the rail has it; else the kind's opening stage; else the first. */
export function currentStage(stages: readonly Stage[], asked: string | null | undefined, flavor: Flavor): Stage | null {
  return stages.find((s) => s.id === asked) ?? stages.find((s) => s.id === OPENS_ON[flavor]) ?? stages[0] ?? null;
}

/* ── Rail edits: each returns the whole saved list, which the draft keeps ─────────────────────────── */

const toSaved = (stages: readonly Stage[]): SavedStage[] =>
  stages.map((s) => ({ id: s.id, ...(s.custom || s.label !== s.builtIn ? { label: s.label } : {}), ...(s.skipped ? { skipped: true } : {}), ...(s.custom ? { custom: true } : {}) }));

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
/** The most stages a board's rail keeps: the draft's schema takes no more (lib/workbench/studio-schema.ts › boardStages). */
export const MAX_STAGES = 24;
/** Why another stage cannot be added, or null. */
export const stageLimit = (count: number): string | null => (count >= MAX_STAGES ? `A board holds up to ${MAX_STAGES} stages. Remove one to add another.` : null);

/**
 * Adds a stage after `after` (or at the end): a preset by its name, or "New stage". Returns the list and the new id. At the
 * limit nothing is added: the list comes back as it was and `id` is null, so an over-long list is never saved.
 */
export function addStage(stages: readonly Stage[], after: string | null, label: string, makeId: () => string): { saved: SavedStage[]; id: string | null } {
  if (stageLimit(stages.length)) return { saved: toSaved(stages), id: null };
  const id = `custom-${makeId()}`;
  const fresh: Stage = { id, label: cleanLabel(label) ?? "New stage", builtIn: null, skipped: false, custom: true, regions: [] };
  const at = after ? stages.findIndex((s) => s.id === after) + 1 : stages.length;
  const next = [...stages.slice(0, at > 0 ? at : stages.length), fresh, ...stages.slice(at > 0 ? at : stages.length)];
  return { saved: toSaved(next), id };
}

/* ── The stage header (§ 6.4) ─────────────────────────────────────────────────────────────────────── */

/**
 * The one filled primary, only on the stage where its action lives (§ 6.4, L836), from what today's board can do:
 *  - Cast: "Review the cast" while a cast card waits for a person (it selects the first such card).
 *  - Storyboard or Shots (Film and Pre-vis, which sit over today's Studio board), whichever holds the plan's card: "Review the plan" while Atomik's plan waits for approval (it selects the plan card, whose own
 *    Approve carries the plan's price; the header never approves or spends).
 * The prototype's priced primaries (Approve 8 shots · 128 cr, Make social cuts · ~9 cr) need actions today's board
 * does not have from a header; they come with the stage contents.
 */
export type StagePrimary = { label: string; card: string };
export function stagePrimary(stage: Pick<Stage, "id"> | null, cards: readonly BoardCard[], flavor: Flavor): StagePrimary | null {
  if (!stage || FLAVOR_BOARD[flavor] !== "studio") return null;
  if (stage.id === "cast") {
    const waiting = cards.find((c) => c.region === "cast" && c.kind !== "group" && variantOf(c) === "cast" && c.state === "needs");
    return waiting ? { label: "Review the cast", card: waiting.id } : null;
  }
  /* The plan belongs to one stage: the one that holds its card. It sits in the Storyboard group while frames are being
     drawn and stands in Shots once the shots have taken the group's place, so only that stage carries the button. */
  const plan = cards.find((c) => c.kind === "plan" && c.state === "needs");
  if (plan) {
    const owner = builtInStages(flavor).find((d) => plan.region !== null && d.regions.includes(plan.region) && (d.id === "storyboard" || d.id === "shots"));
    if (owner && owner.id === stage.id) return { label: "Review the plan", card: plan.id };
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
  "ppm-deck": { title: "The PPM deck is not made yet", line: "The deck for the production meeting is built here from the approved boards." },
  moments: { title: "No moments yet", line: "Find the moments worth clipping in the source, and they are listed here with reasons." },
  voice: { title: "No narration yet", line: "Pick a voice and a language, and the narration is made from the script." },
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

/* ── One edit of the rail (the rail's own events), applied to a list ───────────────────────────────── */

export type StageEdit =
  | { type: "rename"; id: string; label: string }
  | { type: "skip"; id: string; skipped: boolean }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; index: number }
  | { type: "add"; after: string | null; label: string };

/** The saved list after an edit, and the stage to open when the edit made or lost one (`go`: null for none). */
export function applyStageEdit(stages: readonly Stage[], edit: StageEdit, makeId: () => string): { saved: SavedStage[]; go: string | null } {
  switch (edit.type) {
    case "rename": return { saved: renameStage(stages, edit.id, edit.label), go: null };
    case "skip": return { saved: skipStage(stages, edit.id, edit.skipped), go: null };
    case "remove": return { saved: removeStage(stages, edit.id), go: null };
    case "move": return { saved: moveStage(stages, edit.id, edit.index), go: null };
    case "add": { const out = addStage(stages, edit.after, edit.label, makeId); return { saved: out.saved, go: out.id }; }
  }
}
