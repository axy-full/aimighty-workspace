import { textPost } from "../textDirect";
import type { TextReply } from "../textReply";
import { textRouteWorks } from "../textRoute";
import { VISITOR_INSTRUCTIONS } from "./instructions";
import { screenVisitorAnswer, type ScreenReason } from "./screen";

/**
 * The visitor bar (v30 Phase A, item 9): one short answer to a signed-out visitor's question about Particl.
 *
 * - Off unless `VISITOR_BAR_ENABLED` is exactly "1" (the engine switches' rule, lib/engineGate.ts).
 * - One cheap text model through the existing text client (lib/textDirect.ts `textPost`): `VISITOR_BAR_MODEL` when it
 *   names a model on the short list below, the cheapest wired Claude model when it is unset, and no model at all (the
 *   bar answers "no answer just now") when it names anything else.
 * - The text client's plain fetch, not the recovery fetch: a visitor's question is not work the recovery checkpoint
 *   waits for, so visitor traffic never writes an "uncertain" record that could block it.
 * - Its own instructions (lib/visitor/instructions.ts), one question, a small answer budget, no tools: the body sent
 *   is exactly model, max_tokens, temperature and two messages. Nothing here reaches a generation engine, a quote,
 *   a ledger or a workspace (tests/unit/visitorBar.spec.ts pins the imports).
 * - Every answer passes the screen (lib/visitor/screen.ts) before it is returned.
 * - Nothing is logged here; the route logs ids and timings only.
 */

/** The cheapest Claude model with a direct door (lib/textRoute.ts DIRECT_MODEL_IDS), by the checked-in price snapshot. */
export const VISITOR_BAR_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
/** The only models the bar may use: the cheapest confirmed-price model of each direct vendor it may use, by the same
 *  snapshot (tests/unit/visitorBar.spec.ts works that out from the snapshot and compares). */
export const VISITOR_BAR_MODELS: readonly string[] = [VISITOR_BAR_DEFAULT_MODEL, "google/gemini-3.5-flash-lite"];
/** The answer's budget, in output tokens: three short sentences. */
export const VISITOR_BAR_MAX_TOKENS = 200;
/** The longest question accepted, in characters. */
export const VISITOR_BAR_MAX_QUESTION = 500;
const TIMEOUT_MS = 20_000;

type Env = Record<string, string | undefined>;

export function visitorBarEnabled(env: Env = process.env): boolean {
  return env.VISITOR_BAR_ENABLED === "1";
}

/** The model the bar uses: the default when `VISITOR_BAR_MODEL` is unset or blank, the one it names when that is on the
 *  short list, and null (refused: nothing is sent) for anything else. */
export function visitorBarModel(env: Env = process.env): string | null {
  const named = env.VISITOR_BAR_MODEL?.trim();
  if (!named) return VISITOR_BAR_DEFAULT_MODEL;
  return VISITOR_BAR_MODELS.includes(named) ? named : null;
}

/** Control characters, zero-width and direction marks (the Arabic letter mark included), and the invisible tag characters. */
const INVISIBLE = new RegExp(String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]`, "gu");

/** A question as asked, made one line of plain text (invisible characters out); a problem when nothing is left or it is too long. */
export function cleanQuestion(value: unknown): { question: string } | { problem: "empty" | "long" } {
  if (typeof value !== "string") return { problem: "empty" };
  const question = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (!question) return { problem: "empty" };
  if ([...question].length > VISITOR_BAR_MAX_QUESTION) return { problem: "long" };
  return { question };
}

/** The exact request the bar sends: nothing else is ever added to it. */
export function visitorBarRequest(question: string, model: string) {
  return {
    model,
    max_tokens: VISITOR_BAR_MAX_TOKENS,
    temperature: 0.2,
    messages: [
      { role: "system", content: VISITOR_INSTRUCTIONS },
      { role: "user", content: question },
    ],
  };
}

export type VisitorBarSend = (body: string, opts: { timeoutMs: number }) => Promise<TextReply>;
/** The platform's own fetch, read when called (never the recovery fetch, see above). */
export const plainFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
/** The text client with the plain fetch; under ENGINE_MOCK its canned reply (which repeats the question back). */
const send: VisitorBarSend = (body, opts) => textPost(body, { timeoutMs: opts.timeoutMs, mock: "prompt", fetch: plainFetch });

export type VisitorBarResult =
  | { ok: true; answer: string; held: ScreenReason | null; inTokens: number | null; outTokens: number | null }
  | { ok: false; reason: "model" | "unavailable" | "failed" };

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** One question, one screened answer. `deps.send` is the test seam; production uses the text client. */
export async function askVisitorBar(question: string, deps: { send?: VisitorBarSend } = {}): Promise<VisitorBarResult> {
  const model = visitorBarModel();
  /* A model off the short list is refused, never swapped for another: nothing is sent. */
  if (!model) return { ok: false, reason: "model" };
  /* No working door for the model (its vendor is not direct, or has no key): nothing is sent. */
  if (!deps.send && !textRouteWorks(model)) return { ok: false, reason: "unavailable" };
  let reply: TextReply;
  try {
    reply = await (deps.send ?? send)(JSON.stringify(visitorBarRequest(question, model)), { timeoutMs: TIMEOUT_MS });
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!reply.ok) return { ok: false, reason: "failed" };
  let parsed: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try { parsed = JSON.parse(reply.text); } catch { return { ok: false, reason: "failed" }; }
  const content = parsed.choices?.[0]?.message?.content;
  /* The budget bounds it already; the slice is a backstop against a provider that ignores it. */
  const text = typeof content === "string" ? content.trim().slice(0, 2000) : "";
  if (!text) return { ok: false, reason: "failed" };
  const { answer, held } = screenVisitorAnswer(text);
  return { ok: true, answer, held, inTokens: count(parsed.usage?.prompt_tokens), outTokens: count(parsed.usage?.completion_tokens) };
}
