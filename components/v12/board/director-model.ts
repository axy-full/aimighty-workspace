import { effectiveSetup, overriddenKeys, type SettingValue, type Setup } from "@/lib/v12/board/board-data";
import type { Stage } from "@/lib/v12/board/stages";
import { exact, heldUpTo, type PriceValue } from "@/lib/shell/price-words";
import { failureLine } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import { PLAN_APPROVAL_MS, PLAN_LIMITS } from "@/lib/workbench/rig-agent-plan";

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

/**
 * The most shots one press takes: a plan's own bound on what it renders at once (lib/workbench/rig-agent-plan.ts PLAN_LIMITS.next), which is also the batch
 * route's (lib/batchPress.ts BATCH_MAX_MEMBERS; tests/unit/v25-director-model.spec.ts holds the two equal). Past it nothing is priced or sent, and the bar says
 * so in the plan's words (owner, 21 Oct 2026).
 */
export const PRESS_MAX_SHOTS = PLAN_LIMITS.next;
export const PRESS_LIMIT_NOTE = `Up to ${PRESS_MAX_SHOTS} shots at a time. Pick some.`;

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
 * The shots still to start, as the batch route quotes them under the press's own key (lib/batchPress.ts admitBatch, `quoteOnly` with the Idempotency-Key; the
 * press's reply carries it too when shots did not start): never started, or failed at no charge. Started shots and charged failures are not in it.
 */
export type ToStart = { members: number; estimatedCredits: number; ceilingCredits?: number; price?: number; unit?: string };
export function validToStart(v: unknown): v is ToStart {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<ToStart>;
  return Number.isInteger(t.members) && t.members! >= 0 && Number.isInteger(t.estimatedCredits) && t.estimatedCredits! >= 0
    && (t.ceilingCredits == null || (Number.isInteger(t.ceilingCredits) && t.ceilingCredits >= t.estimatedCredits!));
}

/**
 * Retry's price (owner, 21 Oct 2026): only the shots still to start. What failed unbilled re-runs under the same approval; what was charged stays charged and
 * is not in it. It reads as a press's price reads (pressPrice): "N cr", "up to N cr" where a shot holds a ceiling, the house's own dollars at cost.
 *
 * Without the server's figure for the shots left (`toStart`; a route that does not send it yet), or with none left to start, it is the press's own approval as a
 * ceiling, "up to N cr": the most Retry can charge, since it asks under that approval and never past it.
 */
export function retryPrice(price: PriceValue | null | undefined, toStart?: unknown): PriceValue | null {
  /* A free press has nothing to approve again, so Retry carries no price: "up to free" is not a price, and a spend button with no price stays off
     (lib/spend.ts spendAttrsOf). No price, no Retry offered in the bar. */
  if (!price || price.kind === "free") return null;
  if (validToStart(toStart) && toStart.members > 0) return pressPrice(toStart) ?? { ...price, kind: "up-to" };
  return { ...price, kind: "up-to" };
}

/** A failed take known to have been charged: Particl's own ledger settled it above nothing. It is not asked again under the press's approval; Render again is a new press. */
export function failureCharged(failure: TakeFailure | null | undefined): boolean {
  return Boolean(failure?.charge && failure.charge.settled && failure.charge.credits > 0);
}

/**
 * A failed or cancelled take's line on the Director's bar: the shared failure line (lib/errors.ts failureLine: what happened, what it cost, the next step), with
 * rule 14's words for a take that cost nothing. The shared line says "Not billed" (the ledger settled at 0) or "Not charged" (a hold that came back whole); both
 * read "Nothing billed" here. lib/errors.ts itself is unchanged: its other screens keep their words.
 */
export function failureWords(failure: TakeFailure | null | undefined, cancelled: boolean): string {
  const line = failure ? failureLine(failure, { cancelled }).text : cancelled ? "Cancelled" : "Failed";
  return line.replace(/\bNot (?:billed|charged)\b/, "Nothing billed");
}

/** The failed takes' lines, one after another: "Shot 2: … · Nothing billed · …. Shot 3: … · 43 cr charged · …." */
export const failureNote = (failures: readonly { name: string; words: string }[]): string | null =>
  failures.length ? failures.map((f) => `${f.name}: ${f.words.replace(/[.!?]?$/, ".")}`).join(" ") : null;

/* ── The press's claims: each press's key and the approval it was pressed with, kept in this browser until the server has settled it ── */

/** The server's quote for the whole press (lib/batchPress.ts admitBatch with `quoteOnly`): as a new approval would cover it now. */
export type BatchQuote = {
  estimatedCredits: number; ceilingCredits?: number; price?: number; unit?: string; fingerprint: string; members: number;
  /** Quoted under the press's key only: the shots left (Retry's price), and the approval the press holds (`covers`: it still covers the shots left). */
  toStart?: unknown; approval?: { maxCredits?: number; expiresAt?: number; expired?: boolean; covers?: boolean } | null;
};
const FINGERPRINT = /^[a-f0-9]{64}$/;
export function validQuote(q: unknown, members: number): q is BatchQuote {
  if (!q || typeof q !== "object") return false;
  const v = q as Partial<BatchQuote>;
  return Number.isInteger(v.estimatedCredits) && v.estimatedCredits! >= 0 && FINGERPRINT.test(String(v.fingerprint ?? "")) && v.members === members
    && (v.ceilingCredits == null || (Number.isInteger(v.ceilingCredits) && v.ceilingCredits >= v.estimatedCredits!));
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
/**
 * One press. `quote`: the approval it carries (its fingerprint and total), or null when the server refused it as out of date and the person must approve the new
 * total. `answered`: the server has reported this press's shots (which started, which did not); a press never answered (a lost reply, a shot still being accepted)
 * is kept even after Next, because only the server knows what it started. `at`: when the person gave that approval.
 */
export type PressClaim = { key: string; shots: string; quote: BatchQuote | null; answered: boolean; at: number };
/** Claims are kept one per exact set of shots, so a press of other shots never takes the place of one whose reply was lost; the oldest go past this many. */
export const CLAIMS_KEPT = 8;
/**
 * A held approval lasts as a plan's does (owner, 21 Oct 2026: lib/workbench/plan-approval.ts, owner decision 4). Past it the claim is dropped, so the next press
 * of those shots is a new one: quoted afresh at the current price, and approved by a person's press. A claim with no time of approval counts as past it.
 */
export const claimLive = (claim: Pick<PressClaim, "at">, now: number) => Number.isFinite(claim.at) && now - claim.at < PLAN_APPROVAL_MS;
export const claimSlot = (scope: string, projectKey: string) => `particl:director-press:${JSON.stringify([scope, projectKey])}`;
export function readClaims(storage: Storage, slot: string, now: number): PressClaim[] {
  try {
    const raw = storage.getItem(slot);
    const v = raw ? (JSON.parse(raw) as { claims?: unknown } | Partial<PressClaim>) : null;
    /* A claim written before claims were kept per shots (one object) is read as a list of one. */
    const list = Array.isArray((v as { claims?: unknown } | null)?.claims) ? ((v as { claims: unknown[] }).claims) : v && typeof (v as Partial<PressClaim>).key === "string" ? [v] : [];
    return list.flatMap((c) => {
      const x = c as Partial<PressClaim>;
      if (!x || typeof x.key !== "string" || typeof x.shots !== "string") return [];
      const claim = { key: x.key, shots: x.shots, quote: x.quote && validQuote(x.quote, x.quote.members) ? x.quote : null, answered: x.answered === true, at: typeof x.at === "number" ? x.at : Number.NaN };
      return claimLive(claim, now) ? [claim] : [];
    });
  } catch { return []; }
}
export function readClaim(storage: Storage, slot: string, shots: string, now: number): PressClaim | null {
  return readClaims(storage, slot, now).find((c) => c.shots === shots) ?? null;
}
function storeClaims(storage: Storage, slot: string, claims: PressClaim[]) {
  if (!claims.length) { storage.removeItem(slot); return; }
  const text = JSON.stringify({ claims });
  storage.setItem(slot, text);
  if (storage.getItem(slot) !== text) throw new Error("Enable local storage to safely recover this press.");
}
/** Written before anything is sent, in place of the claim for the same shots (the newest last; the oldest past CLAIMS_KEPT, and any past its time, go). Throws when it cannot be kept. */
export function writeClaim(storage: Storage, slot: string, claim: PressClaim, now: number) {
  storeClaims(storage, slot, [...readClaims(storage, slot, now).filter((c) => c.shots !== claim.shots && c.key !== claim.key), claim].slice(-CLAIMS_KEPT));
}
export function letGo(storage: Storage, slot: string, key: string, now: number) {
  try {
    const claims = readClaims(storage, slot, now);
    if (claims.some((c) => c.key === key)) storeClaims(storage, slot, claims.filter((c) => c.key !== key));
  } catch { /* the next press asks under it, and starts nothing twice */ }
}
