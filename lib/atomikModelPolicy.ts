import { aliasModel } from "./modelAliases";
import { atomikEffortOptions } from "./atomik-reasoning";
import type { CatalogModel } from "./catalog";
import modelCatalogJson from "./modelCatalog.json";

/** Claude, OpenAI, Gemini and Grok text/planning models verified against
 * Gateway on 2026-09-15 (Grok's reasoning models on 2026-09-23, listed there
 * under `spacexai/`, priced by the live catalogue like every other). Availability and prices still come from the live catalogue.
 * Image, speech, embeddings, Gemma and safeguard classifiers are separate tools.
 *
 * This is the verified text catalogue. Atomik thinks with at most three Claude models of it, one per Thinking slot, each named by the
 * deployment's env (atomikThinkingSlots below); the prompt enhancer reads the whole of it.
 * Models a provider does not serve on a direct call are not listed: a choice
 * saved on one reads as its alias (lib/modelAliases.ts).
 */
export const VERIFIED_TEXT_MODEL_IDS = [
  /* The current Claude first (owner, 11 Oct 2026): Atomik's default and the planner menu lead with them. */
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-5",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
  "google/gemini-3-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "openai/gpt-3.5-turbo",
  "openai/gpt-4-turbo",
  "openai/gpt-4.1",
  "openai/gpt-4.1-fast",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-mini-fast",
  "openai/gpt-4.1-nano",
  "openai/gpt-4.1-nano-fast",
  "openai/gpt-4o",
  "openai/gpt-4o-fast",
  "openai/gpt-4o-mini",
  "openai/gpt-4o-mini-fast",
  "openai/gpt-5",
  "openai/gpt-5-fast",
  "openai/gpt-5-codex",
  "openai/gpt-5-mini",
  "openai/gpt-5-mini-fast",
  "openai/gpt-5-nano",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-thinking",
  "openai/gpt-5.1-thinking-fast",
  "openai/gpt-5.2",
  "openai/gpt-5.2-fast",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-fast",
  "openai/gpt-5.4",
  "openai/gpt-5.4-fast",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-mini-fast",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
  "openai/gpt-5.5-fast",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-fast",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-fast",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-fast",
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-fast",
  "openai/gpt-oss-120b",
  "spacexai/grok-4.7",
  "spacexai/grok-4.6",
  "spacexai/grok-4.5",
  "spacexai/grok-4.3",
  "spacexai/grok-4.20-reasoning",
  "spacexai/grok-4.1-fast-reasoning",
  "openai/o1",
  "openai/o3",
  "openai/o3-fast",
  "openai/o3-mini",
  "openai/o4-mini",
  "openai/o4-mini-fast"
] as const;

/* ── Atomik's thinking: High · Medium · Low (Amendment (iii) §E, 22 Oct 2026) ─────────────── */

/**
 * Three settings, High · Medium · Low (owner, 22 October 2026), and the models and efforts behind them are never disclosed to the user. A
 * person sees only High · Medium · Low under the word Thinking; the model behind each is the deployment's env (atomikThinkingSlots below,
 * docs/atomik-model-policy.md) and nowhere else.
 */
export const THINKING_SETTINGS = ["high", "medium", "low"] as const;
export type Thinking = (typeof THINKING_SETTINGS)[number];
export const DEFAULT_THINKING: Thinking = "medium";
export const isThinking = (value: unknown): value is Thinking => typeof value === "string" && (THINKING_SETTINGS as readonly string[]).includes(value);

/** The named efforts a setting may run at: the ones lib/atomik-reasoning.ts compiles for a model that offers them ("none" and token budgets are not thinking settings). */
export const THINKING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof THINKING_EFFORTS)[number];
const isEffort = (value: unknown): value is Effort => typeof value === "string" && (THINKING_EFFORTS as readonly string[]).includes(value);

export type ThinkingModel = { model: string; effort: Effort };

/** The models Atomik thinks with: Claude only (owner, 22 Oct 2026). xAI's Grok left the allowlist; OpenAI stays for the Treatment writer alone (treatmentWriter). */
export const ATOMIK_FAMILIES = ["anthropic"] as const;
export type AtomikFamily = (typeof ATOMIK_FAMILIES)[number];

const familyOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("/")));
const inAtomikFamily = (id: string) => (ATOMIK_FAMILIES as readonly string[]).includes(familyOf(id));

/** The verified Claude models: the only ids a Thinking slot may name (the direct door maps each to the vendor's own id, lib/textRoute.ts). */
export const CLAUDE_MODEL_IDS: readonly string[] = VERIFIED_TEXT_MODEL_IDS.filter(inAtomikFamily);

/** A Thinking slot as this deployment runs it: its model, or null when the slot is not set (or names an id outside CLAUDE_MODEL_IDS). */
export type ThinkingSlot = { model: string | null; effort: Effort };

/** The env variable naming each slot's model, and its effort. */
export const thinkingModelEnv = (setting: Thinking) => `ATOMIK_THINKING_${setting.toUpperCase()}_MODEL`;
export const thinkingEffortEnv = (setting: Thinking) => `ATOMIK_THINKING_${setting.toUpperCase()}_EFFORT`;
/** Every slot thinks at high effort unless its effort env names another (owner, 23 Oct 2026: "effort high for all three"). */
const SLOT_EFFORT: Effort = "high";

/**
 * Each slot's model and effort, from the env alone (owner, 23 Oct 2026, option A: no slot is mapped to a model in code). A slot's model is
 * `ATOMIK_THINKING_{HIGH,MEDIUM,LOW}_MODEL`, which must be a verified Claude id (CLAUDE_MODEL_IDS); unset, or any other value, the slot is
 * null and every turn that needs it is refused (THINKING_UNAVAILABLE, nothing billed). Its effort is `ATOMIK_THINKING_{…}_EFFORT`, a named
 * effort (THINKING_EFFORTS), else high. Read when asked, never at start, and never throws: a bad env value cannot take Atomik down.
 */
export function atomikThinkingSlots(env: Readonly<Record<string, string | undefined>> = process.env): Record<Thinking, ThinkingSlot> {
  const allowed = new Set(CLAUDE_MODEL_IDS);
  return Object.fromEntries(THINKING_SETTINGS.map((setting) => {
    const model = env[thinkingModelEnv(setting)]?.trim(), effort = env[thinkingEffortEnv(setting)]?.trim();
    return [setting, { model: model && allowed.has(model) ? model : null, effort: isEffort(effort) ? effort : SLOT_EFFORT }];
  })) as Record<Thinking, ThinkingSlot>;
}

/** Atomik's thinking, per slot, read from the env on every access. */
export const ATOMIK_THINKING: Readonly<Record<Thinking, ThinkingSlot>> = Object.freeze(Object.defineProperties({} as Record<Thinking, ThinkingSlot>,
  Object.fromEntries(THINKING_SETTINGS.map((setting) => [setting, { enumerable: true, get: () => atomikThinkingSlots()[setting] }]))));

/**
 * The only models Atomik may call (owner, 23 Oct 2026, item 14: "three Claude models only"): the configured slots' models, and nothing
 * else. Every Atomik path (thinking, the judge, digests and condense, the memory read, the fallback, Studio Atomik, the board planner,
 * development) resolves to one of these; a fallback chooses among them alone, and never a dearer one than the slot's own.
 */
export function atomikModelIds(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const slots = atomikThinkingSlots(env);
  return [...new Set(THINKING_SETTINGS.flatMap((setting) => slots[setting].model ?? []))];
}

/**
 * The kinds of Atomik turn. The interview (the Brief's questions), the plan and every Writing and Design turn run at the setting;
 * the judge (Reviewing), digests and routine turns run at Low, unless the setting is High.
 */
export const ATOMIK_TURNS = ["interview", "plan", "writing", "design", "judge", "digest", "routine"] as const;
export type AtomikTurn = (typeof ATOMIK_TURNS)[number];
const AT_LOW: ReadonlySet<AtomikTurn> = new Set(["judge", "digest", "routine"]);

export type ThinkingPick = ThinkingSlot & { thinking: Thinking };
/** The slot a turn runs at, under a setting (a value that is not one reads as the default, Medium); its model is null when the slot is not set. */
export function thinkingFor(setting: Thinking, turn: AtomikTurn, map: Readonly<Record<Thinking, ThinkingSlot>> = atomikThinkingSlots()): ThinkingPick {
  const asked = isThinking(setting) ? setting : DEFAULT_THINKING;
  const thinking: Thinking = AT_LOW.has(turn) && asked !== "high" ? "low" : asked;
  return { thinking, ...map[thinking] };
}

/** The one line every Atomik thinking prompt carries (Amendment (iii) §E: the model is never disclosed, not even by the model). */
export const NO_MODEL_NAME = "If asked what model you are, say you are Atomik; never name the model or the company behind you.";

/** What a person is told when no model Atomik thinks with is being served: no model, no effort (never disclosed). */
export const THINKING_UNAVAILABLE = "Atomik's thinking isn't connected right now. Nothing billed.";

/**
 * A turn's model and effort against what the catalogue serves. The setting's model when it is served. When it is not, a served Claude
 * model none of whose rates is higher than the setting's own model's (cheaperFallback), the closest below first: never a dearer one, so a Low
 * turn (the judge, a digest, a routine turn) never falls back upward. It is quoted at what runs. Null when none qualifies (or the
 * setting's own price is not known), and the turn is refused before anything is quoted or charged: nothing falls back to another
 * family. The effort is the setting's where the model's catalogue entry offers it; where the entry offers no such control none is
 * sent, and the model thinks at its own default.
 */
export function selectAtomikThinking(setting: Thinking, turn: AtomikTurn, served: readonly CatalogModel[]): { thinking: Thinking; model: string; entry: CatalogModel; effort?: Effort } | null {
  const slots = atomikThinkingSlots();
  const pick = thinkingFor(setting, turn, slots);
  /* An unset slot (or one naming an id outside the verified catalogue) is refused: nothing stands in for it. */
  if (!pick.model) return null;
  const own = pick.model;
  const ids = [...new Set(THINKING_SETTINGS.flatMap((s) => slots[s].model ?? []))];
  const language = served.filter((m) => m.type === "language");
  const entry = language.find((m) => m.id === own) ?? cheaperFallback(own, language, ids);
  if (!entry) return null;
  return { thinking: pick.thinking, model: entry.id, entry, ...(offersEffort(entry, pick.effort) ? { effort: pick.effort } : {}) };
}
/** Whether a setting is served: its slot names a verified Claude id and the catalogue runs it (or a permitted cheaper fallback); "unset" when the slot is null. */
export type ThinkingService = "served" | "unset" | "unserved";
/**
 * Each setting as a turn at that setting would find it in `served` (the catalogue): the slot is not set, or selectAtomikThinking finds
 * nothing to run it, or it is served. Asked as a plan turn, which runs at the setting itself (thinkingFor). Says no model and no effort.
 */
export function thinkingService(served: readonly CatalogModel[]): Record<Thinking, ThinkingService> {
  const slots = atomikThinkingSlots();
  return Object.fromEntries(THINKING_SETTINGS.map((setting) => [setting,
    !slots[setting].model ? "unset" : selectAtomikThinking(setting, "plan", served) ? "served" : "unserved"])) as Record<Thinking, ThinkingService>;
}
/** The four rates a fallback must not exceed, each per token: input, output, cache read, cache write. */
const RATES = ["input", "output", "input_cache_read", "input_cache_write"] as const;
type Rates = Partial<Record<(typeof RATES)[number], number>>;
const ratesOf = (pricing: CatalogModel["pricing"] | undefined): Rates => {
  const p = (pricing ?? {}) as Record<string, unknown>;
  return Object.fromEntries(RATES.flatMap((key) => {
    const value = p[key] == null ? NaN : Number(p[key]);
    return Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
  }));
};
/** The setting's own model's catalogue rates, from the checked-in catalogue (it is not being served, so the live one has no entry). */
const SNAPSHOT_RATES = new Map<string, Rates>(
  [...((modelCatalogJson as { models?: { id: string; pricing?: CatalogModel["pricing"] }[] }).models ?? []),
   ...((modelCatalogJson as { providerPriced?: { id: string; pricing?: CatalogModel["pricing"] }[] }).providerPriced ?? [])]
    .map((m) => [m.id, ratesOf(m.pricing)] as const),
);
/**
 * A candidate is one of the other slots' models (atomikModelIds) and qualifies only if it dominates: each of its rates no higher than
 * the setting's own model's, so whatever a turn's shape (output-heavy at high effort, cache-heavy on the direct door) the fallback costs no
 * more than the setting's own model would. The setting's own model must state all four rates in the checked-in snapshot, or there is no
 * fallback; the candidate must state all four too (CACHE_RATE_REQUIRED, below). Among those, the closest below first (the dearer by the
 * rates summed), then settings order.
 */
/* Whether a cache rate the candidate does not state disqualifies it: yes (the money review's rule; owner, 23 Oct 2026). */
const CACHE_RATE_REQUIRED = true;
function cheaperFallback(own: string, language: readonly CatalogModel[], ids: readonly string[]): CatalogModel | undefined {
  const ceiling = SNAPSHOT_RATES.get(own);
  /* The setting's own model must state all four rates in the snapshot: a rate it does not state cannot bound a fallback, so there is none. */
  if (!ceiling || RATES.some((key) => ceiling[key] === undefined)) return undefined;
  const dominates = (rates: Rates) => RATES.every((key) => {
    const cap = ceiling[key]!, rate = rates[key];
    if (rate === undefined) return key.startsWith("input_cache") && !CACHE_RATE_REQUIRED;
    return rate <= cap;
  });
  const total = (rates: Rates) => RATES.reduce((sum, key) => sum + (rates[key] ?? 0), 0);
  const rank = (id: string) => ids.indexOf(id);
  return language
    .filter((m) => m.id !== own && ids.includes(m.id))
    .map((m) => ({ m, rates: ratesOf(m.pricing) }))
    .filter(({ rates }) => dominates(rates))
    .sort((a, b) => total(b.rates) - total(a.rates) || rank(a.m.id) - rank(b.m.id))[0]?.m;
}
/** Whether a catalogue entry offers this named effort (lib/atomik-reasoning.ts, the same list the compiler checks). */
export const offersEffort = (entry: CatalogModel, effort: string): boolean => atomikEffortOptions(entry).some((option) => option.value === effort);

const verified = new Set<string>(VERIFIED_TEXT_MODEL_IDS);
/** Any verified text model: the prompt enhancer's catalogue, which is not Atomik's. */
export function isVerifiedTextModel(id: string): boolean {
  return verified.has(id);
}
/** A model Atomik may think with: one of the configured slots' models (atomikModelIds). */
export function isAtomikModel(id: string): boolean {
  return atomikModelIds().includes(id);
}

/** A verified text model Atomik no longer thinks with: Gemini (28 Sep), and since 22 Oct Grok and OpenAI. */
export function isRetiredAtomikModel(id: string): boolean {
  return verified.has(id) && !isAtomikModel(id);
}

/**
 * A chat's stored model as the chat reads now. It is no longer the person's choice: every turn runs the workspace's Thinking setting,
 * so a stored id is never refused and never says anything. A configured slot's model (or a dropped id whose alias is one) reads as
 * stored; any other (another Claude model, or a chat saved on Gemini, Grok or OpenAI) reads as "auto". The stored row is left as it was.
 */
export function savedAtomikChoice(saved: string | null | undefined): { model: string; note: null } {
  const id = aliasModel(saved);
  return { model: id && id !== "auto" && isAtomikModel(id) ? id : "auto", note: null };
}

/* ── The Treatment writer (Amendment (iii) §E, 22 Oct 2026, 22:47) ─────────────────────────── */

/**
 * TREATMENT_WRITER: the one job OpenAI keeps. It writes the Treatment deck's prose and nothing else; Claude, at the Thinking setting,
 * composes everything else. Set by the owner: `TREATMENT_WRITER_MODEL` (an OpenAI id, "openai/<id>" or a bare "gpt-…") and
 * `TREATMENT_WRITER_EFFORT` (a named effort; default "high", and a value that is not one reads as it). Read when asked, never at start.
 * Unset, or an id outside the OpenAI family: null, and the Treatment's prose is refused before anything is quoted or charged.
 */
export function treatmentWriter(env: Readonly<Record<string, string | undefined>> = process.env): ThinkingModel | null {
  const raw = env.TREATMENT_WRITER_MODEL?.trim() ?? "";
  const id = /^gpt-/i.test(raw) ? `openai/${raw}` : raw;
  if (!/^openai\/[a-z0-9][a-z0-9._-]{0,99}$/i.test(id)) return null;
  const effort = env.TREATMENT_WRITER_EFFORT?.trim();
  return { model: id.toLowerCase(), effort: isEffort(effort) ? effort : "high" };
}

/** Why the Treatment's prose cannot be written: no writer is set up, or it is not being served. Says no model. */
export const TREATMENT_WRITER_OFF = "The Treatment writer is not set up. Nothing billed.";
export const TREATMENT_WRITER_UNAVAILABLE = "The Treatment writer isn't connected right now. Nothing billed.";
export class TreatmentWriterOff extends Error {
  readonly status = 503;
  constructor(message: string = TREATMENT_WRITER_OFF) { super(message); this.name = "TreatmentWriterOff"; }
}
