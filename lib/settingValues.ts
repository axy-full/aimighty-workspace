/**
 * The values a workspace setting may hold, for the ones the server reads as a
 * fixed vocabulary. One list serves the settings route (which refuses anything
 * else) and every screen that offers the choice, so a screen can never save a
 * value the gate does not understand.
 *
 * `atCap`, `capWarnPct` and `productionBudgetCredits` are read by lib/caps.ts, `editOutputFormat` by lib/generationAdmission.ts,
 * `atomikThinking` by lib/atomikThinking.ts (its values are lib/atomikModelPolicy.ts THINKING_SETTINGS).
 * (`approvalRule` and `shotCapCredits` were retired on 21 Oct 2026: lib/settings.ts RETIRED_SETTING_KEYS.)
 */

/** The container an edit or extension comes back in; no other delivery reads it. */
export const EDIT_FORMAT_OPTIONS: readonly (readonly [string, string])[] = [
  ["mp4", "MP4"],
  ["mov", "MOV"],
];

export const AT_CAP_OPTIONS: readonly (readonly [string, string])[] = [
  ["producer", "Producer unlocks"],
  ["stop", "Stop rendering"],
  ["warn", "Warn only"],
];

export const CAP_WARN_OPTIONS: readonly (readonly [string, string])[] = [50, 70, 80, 90].map((n) => [String(n), `${n}% of the cap`] as const);

export const ENHANCE_DEFAULT_OPTIONS: readonly (readonly [string, string])[] = [
  ["on", "On"],
  ["off", "Off"],
];

/**
 * Atomik's thinking, as a person sees it: three words, never a model or an effort. The values are lib/atomikModelPolicy.ts
 * THINKING_SETTINGS (tests/unit/atomikThinking.spec.ts holds them equal); written out here so a screen that offers them never
 * loads the policy, and with it the models.
 */
export const THINKING_OPTIONS: readonly (readonly [string, string])[] = [
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];

/** The word a person reads for a stored Thinking value: High, Medium or Low; Medium (the default) for anything else, as the server reads it. */
export function thinkingWord(value: unknown): string {
  return THINKING_OPTIONS.find(([v]) => v === value)?.[1] ?? "Medium";
}

/** A planning quote's head, "Thinking · Medium": only for a level the server sent with the quote (never a guess), else null. */
export function thinkingHead(level: unknown): string | null {
  return THINKING_OPTIONS.some(([v]) => v === level) ? `Thinking · ${thinkingWord(level)}` : null;
}

const allowed = (options: readonly (readonly [string, string])[], value: unknown) => options.some(([v]) => v === String(value));

/** A whole number of credits from 1 up to a million, as a person types it (digits only). */
export function wholeCredits(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return /^\d{1,7}$/.test(text) && Number(text) >= 1 && Number(text) <= 1_000_000;
}

/** Why a value cannot be stored under this key, or null when it can. */
export function settingProblem(key: string, value: unknown): string | null {
  switch (key) {
    case "editOutputFormat": return allowed(EDIT_FORMAT_OPTIONS, value) ? null : "Choose mp4 or mov.";
    case "atCap": return allowed(AT_CAP_OPTIONS, value) ? null : "Choose producer, stop or warn.";
    case "atomikThinking": return allowed(THINKING_OPTIONS, value) ? null : "Choose High, Medium or Low.";
    case "enhanceDefault": return allowed(ENHANCE_DEFAULT_OPTIONS, value) ? null : "Choose on or off.";
    case "productionBudgetCredits": return String(value ?? "").trim() === "" || wholeCredits(value) ? null : "The budget is a whole number of credits, 1 or more, or none.";
    case "capWarnPct": {
      const n = Number(value);
      return String(value).trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 100 ? null : "The warning is a whole percentage from 1 to 100.";
    }
    default: return null;
  }
}
