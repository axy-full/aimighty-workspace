import { aliasModel } from "./modelAliases";
import { atomikEffortOptions } from "./atomik-reasoning";
import type { CatalogModel } from "./catalog";

/** Claude, OpenAI, Gemini and Grok text/planning models verified against
 * Gateway on 2026-09-15 (Grok's reasoning models on 2026-09-23, listed there
 * under `spacexai/`, priced by the live catalogue like every other). Availability and prices still come from the live catalogue.
 * Image, speech, embeddings, Gemma and safeguard classifiers are separate tools.
 *
 * This is the verified text catalogue. Atomik thinks with its Claude part
 * (ATOMIK_MODEL_IDS below, through ATOMIK_THINKING); the prompt enhancer reads the whole of it.
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
 * The owner, 22 October 2026: "lets have 3 settings. High (Fable 5.1/55 high when it launches) Medium (Opus 5.5 high) Low (Sonnet 5.5 high)
 * (never disclose to the user the models and effort settings". A person sees only High · Medium · Low under the word Thinking; the model behind
 * each and its effort live here and nowhere else (docs/atomik-model-policy.md).
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

/** Atomik's part of the verified catalogue: the Claude models. A thinking setting, and any override of one, names one of these. */
export const ATOMIK_MODEL_IDS: readonly string[] = VERIFIED_TEXT_MODEL_IDS.filter(inAtomikFamily);

const THINKING_DEFAULTS: Record<Thinking, ThinkingModel> = {
  high: { model: "anthropic/claude-fable-5.1", effort: "high" },
  medium: { model: "anthropic/claude-opus-5.5", effort: "high" },
  low: { model: "anthropic/claude-sonnet-5.5", effort: "high" },
};

/**
 * The mapping from each setting to its model and effort, from the defaults and the env overrides
 * `ATOMIK_THINKING_{HIGH,MEDIUM,LOW}_MODEL` and `ATOMIK_THINKING_{HIGH,MEDIUM,LOW}_EFFORT`. An override must be a verified Claude id
 * (ATOMIK_MODEL_IDS, the catalogue id: the direct door maps it to the vendor's own, lib/textRoute.ts) and a named effort
 * (THINKING_EFFORTS); anything else is ignored and the default kept. Never throws: a bad env value cannot take Atomik down.
 */
export function thinkingMap(env: Readonly<Record<string, string | undefined>> = process.env): Record<Thinking, ThinkingModel> {
  const allowed = new Set(ATOMIK_MODEL_IDS);
  return Object.fromEntries(THINKING_SETTINGS.map((setting) => {
    const key = setting.toUpperCase();
    const model = env[`ATOMIK_THINKING_${key}_MODEL`]?.trim(), effort = env[`ATOMIK_THINKING_${key}_EFFORT`]?.trim();
    return [setting, {
      model: model && allowed.has(model) ? model : THINKING_DEFAULTS[setting].model,
      effort: isEffort(effort) ? effort : THINKING_DEFAULTS[setting].effort,
    }];
  })) as Record<Thinking, ThinkingModel>;
}

/** Atomik's thinking, per setting, as this deployment runs it (read once, at start). */
export const ATOMIK_THINKING: Readonly<Record<Thinking, ThinkingModel>> = Object.freeze(thinkingMap());

/**
 * The kinds of Atomik turn. The interview (the Brief's questions), the plan and every Writing and Design turn run at the setting;
 * the judge (Reviewing), digests and routine turns run at Low, unless the setting is High.
 */
export const ATOMIK_TURNS = ["interview", "plan", "writing", "design", "judge", "digest", "routine"] as const;
export type AtomikTurn = (typeof ATOMIK_TURNS)[number];
const AT_LOW: ReadonlySet<AtomikTurn> = new Set(["judge", "digest", "routine"]);

export type ThinkingPick = ThinkingModel & { thinking: Thinking };
/** The model and effort a turn runs at, under a setting (a value that is not one reads as the default, Medium). */
export function thinkingFor(setting: Thinking, turn: AtomikTurn, map: Readonly<Record<Thinking, ThinkingModel>> = ATOMIK_THINKING): ThinkingPick {
  const asked = isThinking(setting) ? setting : DEFAULT_THINKING;
  const thinking: Thinking = AT_LOW.has(turn) && asked !== "high" ? "low" : asked;
  return { thinking, ...map[thinking] };
}

/** What a person is told when no model Atomik thinks with is being served: no model, no effort (never disclosed). */
export const THINKING_UNAVAILABLE = "Atomik's thinking isn't connected right now. Nothing billed.";

/**
 * A turn's model and effort against what the catalogue serves. The setting's model when it is served. When it is not, the first served
 * of the other settings' models (Medium, then Low, then High), then the first served Claude model of the verified catalogue, in its
 * order: Atomik still thinks, on Claude only, and the quote is the price of the model that runs, so nothing is charged for a model that
 * did not run. Null when no Claude model is served: nothing falls back to another family. The effort is the setting's where the
 * model's catalogue entry offers it; where the entry offers no such control none is sent, and the model thinks at its own default.
 */
export function selectAtomikThinking(setting: Thinking, turn: AtomikTurn, served: readonly CatalogModel[]): (Omit<ThinkingPick, "effort"> & { entry: CatalogModel; effort?: Effort }) | null {
  const pick = thinkingFor(setting, turn);
  const language = served.filter((m) => m.type === "language");
  const order = [pick.model, ...FALLBACK_ORDER.map((t) => ATOMIK_THINKING[t].model), ...ATOMIK_MODEL_IDS];
  const entry = order.map((id) => language.find((m) => m.id === id)).find((m): m is CatalogModel => Boolean(m));
  if (!entry) return null;
  return { thinking: pick.thinking, model: entry.id, entry, ...(offersEffort(entry, pick.effort) ? { effort: pick.effort } : {}) };
}
const FALLBACK_ORDER: readonly Thinking[] = ["medium", "low", "high"];
/** Whether a catalogue entry offers this named effort (lib/atomik-reasoning.ts, the same list the compiler checks). */
export const offersEffort = (entry: CatalogModel, effort: string): boolean => atomikEffortOptions(entry).some((option) => option.value === effort);

/** What Atomik plans with when nothing else is known: the default setting's model. */
export const ATOMIK_DEFAULT_MODEL = ATOMIK_THINKING[DEFAULT_THINKING].model;

const verified = new Set<string>(VERIFIED_TEXT_MODEL_IDS);
const allowed = new Set<string>(ATOMIK_MODEL_IDS);
/** Any verified text model: the prompt enhancer's catalogue, which is not Atomik's. */
export function isVerifiedTextModel(id: string): boolean {
  return verified.has(id);
}
/** A model Atomik may think with (a Claude model of the verified catalogue). */
export function isAtomikModel(id: string): boolean {
  return allowed.has(id);
}

/** A verified text model Atomik no longer thinks with: Gemini (28 Sep), and since 22 Oct Grok and OpenAI. */
export function isRetiredAtomikModel(id: string): boolean {
  return verified.has(id) && !allowed.has(id);
}

/**
 * A chat's stored model as the chat reads now. It is no longer the person's choice: every turn runs the workspace's Thinking setting,
 * so a stored id is never refused and never says anything. A Claude id (or a dropped one, as its alias) reads as stored; any other
 * (a chat saved on Gemini, Grok or OpenAI) reads as "auto". The stored row is left as it was.
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
