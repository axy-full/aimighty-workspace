import { aliasModel } from "./modelAliases";

/** Claude, OpenAI, Gemini and Grok text/planning models verified against
 * Gateway on 2026-09-15 (Grok's reasoning models on 2026-09-23, listed there
 * under `spacexai/`, priced by the live catalogue like every other). Availability and prices still come from the live catalogue.
 * Image, speech, embeddings, Gemma and safeguard classifiers are separate tools.
 *
 * This is the verified text catalogue. Atomik plans on part of it
 * (ATOMIK_MODEL_IDS below); the prompt enhancer reads the whole of it.
 * Models a provider does not serve on a direct call are not listed: a choice
 * saved on one reads as its alias (lib/modelAliases.ts).
 */
export const VERIFIED_TEXT_MODEL_IDS = [
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

/**
 * The model families Atomik's agentic workflow runs on (owner, 28 Sep 2026):
 * Claude, OpenAI and Grok, through the same Gateway routing and live
 * catalogue pricing as before. Gateway lists xAI's Grok under `spacexai/`.
 */
export const ATOMIK_FAMILIES = ["anthropic", "openai", "spacexai"] as const;
export type AtomikFamily = (typeof ATOMIK_FAMILIES)[number];
export const ATOMIK_FAMILY_LABEL: Record<AtomikFamily, string> = { anthropic: "Claude", openai: "OpenAI", spacexai: "Grok" };

const familyOf = (id: string) => id.slice(0, Math.max(0, id.indexOf("/")));
const inAtomikFamily = (id: string) => (ATOMIK_FAMILIES as readonly string[]).includes(familyOf(id));

/** Atomik's planner and agent models: the verified catalogue, Claude, OpenAI and Grok only. The first is the default. */
export const ATOMIK_MODEL_IDS: readonly string[] = VERIFIED_TEXT_MODEL_IDS.filter(inAtomikFamily);

/** Keep Auto's established production choices stable as the full picker expands. GPT-5.5 Pro left with the dropped ids; its alias, GPT-5.5, takes its place (lib/modelAliases.ts). */
export const ATOMIK_AUTO_MODEL_IDS = [
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.5"
] as const;

/** What Auto plans with when nothing else routes it: the first Atomik model. */
export const ATOMIK_DEFAULT_MODEL = ATOMIK_MODEL_IDS[0];

const verified = new Set<string>(VERIFIED_TEXT_MODEL_IDS);
const allowed = new Set<string>(ATOMIK_MODEL_IDS);
/** Any verified text model: the prompt enhancer's catalogue, which is not Atomik's. */
export function isVerifiedTextModel(id: string): boolean {
  return verified.has(id);
}
export function isAtomikModel(id: string): boolean {
  return allowed.has(id);
}

/**
 * A choice Atomik used to offer and no longer does: a verified text model
 * outside the three families (the Gemini models).
 */
export function isRetiredAtomikModel(id: string): boolean {
  return verified.has(id) && !allowed.has(id);
}

const retiredLead = (id: string) =>
  `${familyOf(id) === "google" ? "Gemini" : "That model"} is no longer offered in Atomik, which now plans with Claude, OpenAI and Grok.`;

/**
 * A saved choice as Atomik reads it now. A dropped id reads as its alias, the
 * nearest model still offered (lib/modelAliases.ts), with nothing to say: the
 * person's choice stands, on the model that runs. One Atomik no longer offers
 * at all (a chat saved on Gemini) plans with Auto, the default, and carries the
 * note that says so; anything else is kept as it was.
 */
export function savedAtomikChoice(saved: string | null | undefined): { model: string; note: string | null } {
  const id = aliasModel(saved);
  if (id && isRetiredAtomikModel(id)) return { model: "auto", note: `${retiredLead(id)} This chat now uses Auto.` };
  return { model: id || "auto", note: null };
}

/**
 * Explicit choices never fall back to a different paid model (a dropped id is
 * read as its alias, the nearest offered model): a request naming a retired one is refused with the reason, and the person picks again
 * against a fresh estimate. Auto can only route within this policy.
 */
export function selectAtomikModel(wanted: string, availableIds: readonly string[], routedTo?: string): string {
  /* A dropped id (saved, routed or sent by an older page) is its alias before any check: that is the model quoted and run. */
  const want = aliasModel(wanted), routed = aliasModel(routedTo);
  const available = new Set(availableIds.filter(isAtomikModel));
  if (want && want !== "auto") {
    if (isRetiredAtomikModel(want)) throw new Error(`${retiredLead(want)} Choose one of those, or Auto.`);
    if (!isAtomikModel(want)) throw new Error("That thinking model is not offered in Atomik. Choose a supported model.");
    if (!available.has(want)) throw new Error("That Atomik model is currently unavailable. Choose another model or Auto.");
    return want;
  }
  if (routed && available.has(routed)) return routed;
  const first = ATOMIK_MODEL_IDS.find(id => available.has(id));
  if (!first) throw new Error("No supported Atomik thinking model is connected. Check AI Gateway configuration.");
  return first;
}
