import { textPost } from "../textDirect";
import type { TextReply } from "../textReply";
import { DIRECT_MODEL_IDS, DIRECT_PRICE_TO_CONFIRM, textRouteWorks } from "../textRoute";
import { VISITOR_INSTRUCTIONS } from "./instructions";
import { screenVisitorAnswer, type ScreenReason } from "./screen";

/**
 * The visitor bar (v30 Phase A, item 9): one short answer to a signed-out visitor's question about Particl.
 *
 * - Off unless `VISITOR_BAR_ENABLED` is exactly "1" (the engine switches' rule, lib/engineGate.ts).
 * - One cheap text model through the existing text client (lib/textDirect.ts `textPost`), named by
 *   `VISITOR_BAR_MODEL`; unset or not a mapped direct text model, the cheapest wired Claude model.
 * - Its own instructions (lib/visitor/instructions.ts), one question, a small answer budget, no tools: the body sent
 *   is exactly model, max_tokens, temperature and two messages. Nothing here reaches a generation engine, a quote,
 *   a ledger or a workspace (tests/unit/visitorBar.spec.ts pins the imports).
 * - Every answer passes the screen (lib/visitor/screen.ts) before it is returned.
 * - Nothing is logged here; the route logs ids and timings only.
 */

/** The cheapest Claude model with a direct door (lib/textRoute.ts DIRECT_MODEL_IDS), by the checked-in price snapshot. */
export const VISITOR_BAR_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
/** The answer's budget, in output tokens: three short sentences. */
export const VISITOR_BAR_MAX_TOKENS = 200;
/** The longest question accepted, in characters. */
export const VISITOR_BAR_MAX_QUESTION = 500;
const TIMEOUT_MS = 20_000;

type Env = Record<string, string | undefined>;

export function visitorBarEnabled(env: Env = process.env): boolean {
  return env.VISITOR_BAR_ENABLED === "1";
}

/** The model the bar uses: the one `VISITOR_BAR_MODEL` names when it is a mapped direct text model with a confirmed price, else the default. */
export function visitorBarModel(env: Env = process.env): string {
  const named = env.VISITOR_BAR_MODEL?.trim();
  return named && Object.hasOwn(DIRECT_MODEL_IDS, named) && !DIRECT_PRICE_TO_CONFIRM.includes(named) ? named : VISITOR_BAR_DEFAULT_MODEL;
}

/** A question as asked, made one line of plain text (control and direction characters out); a problem when nothing is left or it is too long. */
export function cleanQuestion(value: unknown): { question: string } | { problem: "empty" | "long" } {
  if (typeof value !== "string") return { problem: "empty" };
  const question = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!question) return { problem: "empty" };
  if ([...question].length > VISITOR_BAR_MAX_QUESTION) return { problem: "long" };
  return { question };
}

/** The exact request the bar sends: nothing else is ever added to it. */
export function visitorBarRequest(question: string, model: string = visitorBarModel()) {
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
/** The text client, under ENGINE_MOCK its canned reply (which repeats the question back). */
const send: VisitorBarSend = (body, opts) => textPost(body, { timeoutMs: opts.timeoutMs, mock: "prompt" });

export type VisitorBarResult =
  | { ok: true; answer: string; held: ScreenReason | null; inTokens: number | null; outTokens: number | null }
  | { ok: false; reason: "unavailable" | "failed" };

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** One question, one screened answer. `deps.send` is the test seam; production uses the text client. */
export async function askVisitorBar(question: string, deps: { send?: VisitorBarSend; model?: string } = {}): Promise<VisitorBarResult> {
  const model = deps.model ?? visitorBarModel();
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
