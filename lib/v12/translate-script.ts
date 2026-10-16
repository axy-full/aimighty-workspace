/**
 * The Hindi script: the Script step's translate tool, as the board calls it (docs/plans/demo-31oct-plan.md PR 11; rule 11).
 *
 * One interface for the button, a board card, Atomik and an outside agent: a quote (nothing is reserved, nothing is called) and a
 * run (a person approves the price first). Pure: no React, no fetch (tests/unit/v12-translate-script.spec.ts).
 *
 * UNTIL SARVAM'S TOOL LANDS (#777: POST /api/sarvam { tool: "translate", source, target, text, quoteOnly | maxCredits }), the endpoint is a
 * stand-in that answers under ENGINE_MOCK=1 alone and is "no such tool" everywhere else, so nothing here can bill. When #777 merges, only
 * `TRANSLATE_ENDPOINT` and the two builders below change to its body; the screen, the quote and the reply shapes do not (the stand-in
 * answers the same fields: `estimatedCredits`, `price`, `unit` for a quote; `ok`, `text` for a run).
 */
export const TRANSLATE_ENDPOINT = "/api/v12/translate-script";

/** English and Hindi, as Sarvam names them. */
export const SOURCE_LANGUAGE = "en-IN";
export const HINDI = "hi-IN";

/** One request takes this much text (Sarvam's default translate model, lib/sarvamTools.ts); longer is refused in words, never split. */
export const TRANSLATE_MAX_CHARS = 2_000;

export const TOO_LONG = `The Hindi script takes up to ${TRANSLATE_MAX_CHARS.toLocaleString("en-US")} characters at a time. Shorten the script, or ask Atomik to do it in parts.`;

/** Why this text cannot be translated, or null. */
export function translateProblem(text: string): string | null {
  const chars = [...text.trim()].length;
  if (!chars) return "Write the script first.";
  return chars > TRANSLATE_MAX_CHARS ? TOO_LONG : null;
}

export type TranslateAsk = { text: string; target?: string };

/** The body of a quote: asks what it would cost, reserves nothing. */
export const quoteBody = ({ text, target = HINDI }: TranslateAsk) => ({ text: text.trim(), source: SOURCE_LANGUAGE, target, mode: "quote" as const });

/**
 * The body of a run: a person's press, approving up to `approved`, the very figure the button showed, in the unit it showed (credits; the
 * house workspace's dollars). Never worked out from another figure, so a price the person did not see is never approved.
 */
export const runBody = (ask: TranslateAsk, approved: number) => ({ ...quoteBody(ask), mode: "run" as const, approved });

export type TranslateResult = { ok: true; text: string; charged: number } | { ok: false; error: string; /** True when nothing was billed. */ free: boolean };

/** A run's reply as the screen reads it. A refusal that cost nothing says so ("Nothing billed"), as every failed step does. */
export function translateFromResponse(ok: boolean, body: unknown): TranslateResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (ok && b.ok === true && typeof b.text === "string") return { ok: true, text: b.text, charged: typeof b.estimatedCredits === "number" ? b.estimatedCredits : 0 };
  const said = typeof b.error === "string" && b.error.trim() ? b.error.trim() : "The Hindi script could not be made.";
  return { ok: false, error: /nothing was billed/i.test(said) ? said : `${said} Nothing billed.`, free: true };
}
