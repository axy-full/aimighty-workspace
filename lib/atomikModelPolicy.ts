/** Claude, OpenAI and Gemini text/planning models verified against Gateway on
 * 2026-09-15. Availability and prices still come from the live catalogue.
 * Image, speech, embeddings, Gemma and safeguard classifiers are separate tools.
 */
export const ATOMIK_MODEL_IDS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.5-pro",
  "anthropic/claude-3-haiku",
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.8-fast",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-fast",
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
  "openai/gpt-5-pro",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-thinking",
  "openai/gpt-5.1-thinking-fast",
  "openai/gpt-5.2",
  "openai/gpt-5.2-fast",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.2-pro",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-fast",
  "openai/gpt-5.4",
  "openai/gpt-5.4-fast",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-mini-fast",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.4-pro",
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
  "openai/gpt-oss-20b",
  "openai/o1",
  "openai/o3",
  "openai/o3-fast",
  "openai/o3-mini",
  "openai/o3-pro",
  "openai/o4-mini",
  "openai/o4-mini-fast"
] as const;

/** Keep Auto's established production choices stable as the full picker expands. */
export const ATOMIK_AUTO_MODEL_IDS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.5-pro"
] as const;

const allowed = new Set<string>(ATOMIK_MODEL_IDS);
export function isAtomikModel(id: string): boolean {
  return allowed.has(id);
}

/** Explicit choices never fall back; Auto can only route within this policy. */
export function selectAtomikModel(want: string, availableIds: readonly string[], routed?: string): string {
  const available = new Set(availableIds.filter(isAtomikModel));
  if (want && want !== "auto") {
    if (!isAtomikModel(want)) throw new Error("That thinking model is not offered in Atomik. Choose a supported model.");
    if (!available.has(want)) throw new Error("That Atomik model is currently unavailable. Choose another model or Auto.");
    return want;
  }
  if (routed && available.has(routed)) return routed;
  const first = ATOMIK_MODEL_IDS.find(id => available.has(id));
  if (!first) throw new Error("No supported Atomik thinking model is connected. Check AI Gateway configuration.");
  return first;
}
