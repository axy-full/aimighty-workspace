import { effectiveSetup, overriddenKeys, type SettingValue, type Setup } from "@/lib/v12/board/board-data";
import type { Stage } from "@/lib/v12/board/stages";

/**
 * Director mode on Shots (v25 PR 7; design/particl-prototype-25 README, "Director · Shots": the column, the scope pill and the bar). Pure: no React, no fetch
 * (tests/unit/v25-director-model.spec.ts). The settings are PR 4's board data (lib/v12/board/board-data.ts): the step's setup in Director mode, and a card's
 * own overrides on top; a card shows a chip only for a setting that differs from its step's.
 *
 * The model is Auto and is shown as one line (rule 13); its pop-up, and the Pro pick, are PR 9's. Prices are never here: the server quotes the exact requests
 * (POST /api/generate/quote) and the bar shows their sum.
 */
export const SHOTS_STEP = "shots";

export type SettingChoice = { value: SettingValue; label: string };
export type SettingItem = { id: string; label: string; choices: readonly SettingChoice[]; default: SettingValue };

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const LENGTHS = [3, 4, 5, 6, 8, 10] as const;

/** The column's items for Shots, top to bottom. Quality is the draft/final split of the product: a draft is the cheap 480p take, a final the hero take. */
export const SHOTS_SETTINGS: readonly SettingItem[] = [
  { id: "quality", label: "Quality", default: "final", choices: [{ value: "draft", label: "Draft" }, { value: "final", label: "Final" }] },
  { id: "length", label: "Length", default: 5, choices: LENGTHS.map((n) => ({ value: n, label: `${n} s` })) },
  { id: "ratio", label: "Ratio", default: "16:9", choices: RATIOS.map((r) => ({ value: r, label: r })) },
  { id: "sound", label: "Sound", default: false, choices: [{ value: false, label: "Off" }, { value: true, label: "On" }] },
];

export const itemById = (id: string): SettingItem | undefined => SHOTS_SETTINGS.find((item) => item.id === id);

/** A value's words in its item ("Final", "5 s", "16:9", "Off"). A value the item does not offer reads as its default's. */
export function valueWords(item: SettingItem, value: SettingValue | undefined): string {
  const choice = item.choices.find((c) => c.value === value) ?? item.choices.find((c) => c.value === item.default);
  return choice?.label ?? String(item.default);
}

/** What a card runs with: Director's standard defaults, then the step's setup, then the card's own overrides. */
export function shotSettings(draft: Parameters<typeof effectiveSetup>[0], card: string | null): Setup {
  const set = effectiveSetup(draft, { mode: "director", step: SHOTS_STEP, card });
  return Object.fromEntries(SHOTS_SETTINGS.map((item) => {
    const v = set[item.id];
    return [item.id, item.choices.some((c) => c.value === v) ? (v as SettingValue) : item.default];
  }));
}

/** The request fields a Shots setting set means: draft is 480p and flagged, final is 1080p. */
export function requestFields(settings: Setup): { resolution: string; draft: boolean; duration: number; ratio: string; generateAudio: boolean } {
  const draft = settings.quality === "draft";
  return { resolution: draft ? "480p" : "1080p", draft, duration: Number(settings.length) || 5, ratio: String(settings.ratio || "16:9"), generateAudio: settings.sound === true };
}

/** The chips a card shows: only the settings it sets differently from its step ("Draft", "6 s"). */
export function cardChips(draft: Parameters<typeof overriddenKeys>[0], card: string): { id: string; label: string }[] {
  const own = overriddenKeys(draft, { mode: "director", step: SHOTS_STEP, card });
  const now = shotSettings(draft, card);
  return SHOTS_SETTINGS.filter((item) => own.includes(item.id)).map((item) => ({ id: item.id, label: item.id === "sound" ? (now.sound === true ? "Sound" : "No sound") : valueWords(item, now[item.id]) }));
}

/** Which shots a press acts on: the selection, else every shot. The same words name it in the pill, the column's header and the button. */
export type Scope = { ids: string[]; all: boolean; /** "All 8 shots", "Shot 4", "3 shots". */ label: string; /** "8 shots", "Shot 4", "3 shots". */ short: string };
export function scopeOf(selected: readonly string[], shots: readonly { id: string; name: string }[]): Scope {
  const chosen = shots.filter((s) => selected.includes(s.id));
  if (!chosen.length) return { ids: shots.map((s) => s.id), all: true, label: `All ${shots.length} ${shots.length === 1 ? "shot" : "shots"}`, short: `${shots.length} ${shots.length === 1 ? "shot" : "shots"}` };
  const words = chosen.length === 1 ? chosen[0].name : `${chosen.length} shots`;
  return { ids: chosen.map((s) => s.id), all: false, label: words, short: words };
}

export type BarState = "idle" | "sending" | "making" | "done";

/** The bar's one filled button. Idle: what pressing it makes; sending and making: "Making…"; done: the way on. */
export function barButton(input: { state: BarState; scope: Scope; next: string | null }): string {
  if (input.state === "sending" || input.state === "making") return "Making…";
  if (input.state === "done") return input.next ? `Next: ${input.next} →` : "Done";
  return `Render ${input.scope.short}`;
}

/** The step after the current one on the rail: the next stage not skipped. Removed stages are not in `stages` at all (lib/v12/board/stages.ts drops them). */
export function nextStepOf(stages: readonly Pick<Stage, "id" | "label" | "skipped">[], current: string): { id: string; label: string } | null {
  const at = stages.findIndex((s) => s.id === current);
  if (at < 0) return null;
  const next = stages.slice(at + 1).find((s) => !s.skipped);
  return next ? { id: next.id, label: next.label } : null;
}
export const nextStepLabel = (stages: readonly Pick<Stage, "id" | "label" | "skipped">[], current: string): string | null => nextStepOf(stages, current)?.label ?? null;

/** Cancel is offered only while a take is still held in the provider's queue: after that the provider has started it and a cancel is not ours to promise. */
export const cancellable = (statuses: readonly string[]) => statuses.length > 0 && statuses.some((s) => s === "queued");
