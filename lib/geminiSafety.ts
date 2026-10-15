/**
 * The one safety configuration every Gemini request carries (owner, 14 Oct 2026: "Set all four adjustable categories (harassment, hate speech, sexually explicit,
 * dangerous content) to BLOCK_NONE on every Gemini call where the setting is supported. Google's own fixed filters stay as they are; we don't try to get around them.
 * One shared config used by every Gemini call, not set per call").
 *
 * Nothing else builds `safetySettings` or names a HARM_CATEGORY_*: images (lib/gemini.ts, both doors) and text (lib/language-provider.ts, direct and through the gateway)
 * take it from here, and tests/unit/geminiSafety.spec.ts pins it, and scans the source for any other, so it cannot change silently. It is not a setting: there is no
 * environment override.
 *
 * What these four do not reach, Google's own fixed filters (a blocked prompt, a prohibited-content or image-safety finish), still blocks. That is shown to the person as
 * a plain message, charges nothing, and logs only the reason and the take's id, never the prompt or the output (`safetyBlockLog`, `SAFETY_BLOCK_MESSAGE`).
 */
export const GEMINI_SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
] as const;

export type GeminiSafetySetting = Readonly<{ category: (typeof GEMINI_SAFETY_CATEGORIES)[number]; threshold: "BLOCK_NONE" }>;

export const GEMINI_SAFETY_SETTINGS: readonly GeminiSafetySetting[] = Object.freeze(
  GEMINI_SAFETY_CATEGORIES.map((category) => Object.freeze({ category, threshold: "BLOCK_NONE" as const })),
);

/** The settings, as a request body takes them. */
export const geminiSafetySettings = (): readonly GeminiSafetySetting[] => GEMINI_SAFETY_SETTINGS;

/** The same settings as the language SDK's provider options (the direct door and the gateway read them under `google`, and `vertex` where the gateway serves it from there). */
export function geminiSafetyProviderOptions(): { google: { safetySettings: GeminiSafetySetting[] }; vertex: { safetySettings: GeminiSafetySetting[] } } {
  return { google: { safetySettings: GEMINI_SAFETY_SETTINGS.map((s) => ({ ...s })) }, vertex: { safetySettings: GEMINI_SAFETY_SETTINGS.map((s) => ({ ...s })) } };
}

/* ── What a block by Google's own fixed filters says to the person, and to the log ── */

/** Plain words for a person; no model, no vendor, nothing of the prompt. */
export const SAFETY_BLOCK_MESSAGE = "This one was blocked by the image service's safety filter. Nothing was charged.";
export const TEXT_SAFETY_BLOCK_MESSAGE = "This one was blocked by the text service's safety filter. Nothing was charged.";

/** The finish and block reasons Google's fixed filters answer with (Gemini API: promptFeedback.blockReason, candidates[].finishReason), and the gateway's spelling. */
const BLOCKS = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT|IMAGE_RECITATION|RECITATION|SPII|OTHER_BLOCK|BLOCKED_REASON_UNSPECIFIED|CONTENT_FILTER|CONTENT-FILTER)$/;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const code = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase().replace(/\s+/g, "_");
  return BLOCKS.test(upper) ? upper.replace("CONTENT-FILTER", "CONTENT_FILTER") : null;
};

/**
 * The reason Google's fixed filters blocked a Gemini answer, or null when nothing says so. Looks only at the provider's own codes (a prompt block's `blockReason`, a candidate's
 * `finishReason`, the gateway's `finish_reason` / `native_finish_reason`), in the answer's top level, its first candidate or choice, and its steps; it never reads the text.
 */
export function geminiBlockReason(answer: unknown): string | null {
  const root = record(answer);
  if (!root) return null;
  const feedback = record(root.promptFeedback) ?? record(root.prompt_feedback);
  const candidate = Array.isArray(root.candidates) ? record(root.candidates[0]) : null;
  const choice = Array.isArray(root.choices) ? record(root.choices[0]) : null;
  const steps = Array.isArray(root.steps) ? root.steps.map(record) : [];
  const sources = [feedback?.blockReason, feedback?.block_reason, candidate?.finishReason, candidate?.finish_reason, choice?.finish_reason, choice?.native_finish_reason, root.finishReason, root.finish_reason, root.blockReason, root.block_reason,
    ...steps.flatMap((step) => [step?.finishReason, step?.finish_reason])];
  for (const source of sources) { const found = code(source); if (found) return found; }
  return null;
}

/** The one log line for a block: the event, the reason and the take's id, never the prompt or the output. */
export function safetyBlockLog(reason: string, generationId: string | null): string {
  return JSON.stringify({ event: "gemini_safety_block", reason: code(reason) ?? "blocked", generationId });
}
