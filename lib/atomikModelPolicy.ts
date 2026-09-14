/** Verified against Higgsfield's Supercomputer overview and the public AI Gateway
 * catalogue on 2026-09-14. This allowlist is a product boundary, not discovery:
 * newly listed Gateway models must never become Atomik options automatically.
 */
export const ATOMIK_MODEL_IDS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.5-pro",
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
