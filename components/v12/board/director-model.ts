import { effectiveSetup, overriddenKeys, type SettingValue, type Setup } from "@/lib/v12/board/board-data";
import type { Stage } from "@/lib/v12/board/stages";
import { exact, heldUpTo, type PriceValue } from "@/lib/shell/price-words";

/**
 * Director mode on Shots (v25 PR 7; design/particl-prototype-25 README, "Director · Shots": the column, the scope pill and the bar). Pure: no React, no fetch
 * (tests/unit/v25-director-model.spec.ts). The settings are PR 4's board data (lib/v12/board/board-data.ts): the step's setup in Director mode, and a card's
 * own overrides on top; a card shows a chip only for a setting that differs from its step's.
 *
 * Director is full manual control (owner, 16 Oct 2026, 2a): no "Auto" engine. The model line opens empty and Render stays off until the person picks an engine;
 * the picker itself is PR 9's. Prices are never here: the server quotes the whole press as one job (POST /api/generate/batch, #815) and the bar shows its total.
 */
export const SHOTS_STEP = "shots";

/** The engine the person picked for the step, or null: Director never picks one for them. */
export type PickedEngine = { id: string; label: string };
/** The model line's words: the picked engine's name, else "None". */
export const modelWords = (engine: PickedEngine | null | undefined): string => engine?.label ?? "None";
/** The bar's words while no engine is picked: Render is off until one is. */
export const NO_ENGINE_NOTE = "Pick an engine first.";

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

/** The step after the current one on the rail: the next stage not skipped, by its label. Removed stages are not in `stages` (lib/v12/board/stages.ts drops them). */
export function nextStepLabel(stages: readonly Pick<Stage, "id" | "label" | "skipped">[], current: string): string | null {
  const at = stages.findIndex((s) => s.id === current);
  if (at < 0) return null;
  return stages.slice(at + 1).find((s) => !s.skipped)?.label ?? null;
}

/** Cancel is offered only while a take is still held in the provider's queue: after that the provider has started it and a cancel is not ours to promise. */
export const cancellable = (statuses: readonly string[]) => statuses.length > 0 && statuses.some((s) => s === "queued");

/**
 * A press's price as the bar shows it, from the server's quote for the whole press (POST /api/generate/batch, `quoteOnly`): "N cr" (the house: its dollars at
 * cost, where the server gave them), or, when a shot holds a ceiling above its estimate, the ceiling as a hold, "up to N cr". A hold is kept in credits, so in the
 * house workspace it reads at the public price of a credit, its dollars at cost (lib/shell/price-words.ts heldUpTo), as every other hold reads there: never "—".
 */
export function pressPrice(q: { estimatedCredits: number; ceilingCredits?: number; price?: number; unit?: string }): PriceValue | null {
  if (q.ceilingCredits != null && q.ceilingCredits > q.estimatedCredits) return heldUpTo(q.ceilingCredits);
  return exact(q.estimatedCredits, q.unit === "usd" && Number.isFinite(q.price) ? q.price : undefined);
}

/**
 * Retry's price: the press's own approval as a ceiling, "up to N cr" (it asks again under that approval, and never charges past it). Read the same way the
 * press's price reads: its own dollars at cost in the house where the server gave them, a hold at a credit's public price; never credits re-priced by hand.
 */
export function retryPrice(price: PriceValue | null | undefined): PriceValue | null {
  if (!price || price.kind === "free") return null;
  return { ...price, kind: "up-to" };
}
