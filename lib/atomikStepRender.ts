import type { Step } from "./atomik";

/**
 * The render an approved Atomik step makes, as the ordinary routes take it.
 *
 * One builder for the three places that must agree on it: the free quote the
 * rail asks for before Continue is offered, the paid request Continue sends,
 * and the server's advance estimate for an audio step. A price is only true
 * for the exact body it was quoted on, so none of them builds its own.
 *
 * `refine: false` because the planner already wrote the prompt to be rendered
 * exactly as written, and because the quote route prices without the prompt
 * writer: an unquoted paid rewrite has no place behind a priced button.
 *
 * Pure, and type-only in its imports, so the browser can use it.
 */
export type StepRender = {
  /** Where Continue sends it. */
  url: "/api/audio" | "/api/generate";
  /** Where it is priced first, for nothing. */
  quoteUrl: "/api/audio" | "/api/generate/quote";
  body: Record<string, unknown>;
};

type Renderable = Pick<Step, "kind" | "title" | "prompt" | "model" | "params" | "refs">;

/** The audio task a step runs: the planner's own, or a sound effect. */
export function stepAudioTask(params: Record<string, unknown>): string {
  return typeof params.task === "string" && params.task ? params.task : "sound";
}

export function stepRender(step: Renderable, projectId: string | null): StepRender {
  const seconds = Number(step.params.seconds) || undefined;
  if (step.kind === "audio")
    return {
      url: "/api/audio",
      quoteUrl: "/api/audio",
      body: { task: stepAudioTask(step.params), text: step.prompt, projectId, title: step.title, durationSeconds: seconds },
    };
  return {
    url: "/api/generate",
    quoteUrl: "/api/generate/quote",
    body: {
      prompt: step.prompt, model: step.model, projectId, ratio: step.params.ratio, resolution: step.params.resolution,
      duration: seconds, references: step.refs?.length ? step.refs : undefined, refine: false,
    },
  };
}

/** A quote the admission route answered for one exact body. */
export type StepQuote = { estimatedCredits: number; price: number; fingerprint: string | null };

/** The answer of /api/audio (quoteOnly) or /api/generate/quote, checked; null when it is not a usable quote. */
export function readStepQuote(value: unknown, render: Pick<StepRender, "url">): StepQuote | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const credits = v.estimatedCredits, price = v.price, fingerprint = v.fingerprint;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 0) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  if (v.unit !== "cr" && v.unit !== "usd") return null;
  /* /api/generate checks the compiled request against the quote's fingerprint; audio has none. */
  if (render.url === "/api/generate" && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) return null;
  return { estimatedCredits: credits, price, fingerprint: typeof fingerprint === "string" ? fingerprint : null };
}

/** A quote, or why there is none and whether asking again later could help. */
export type StepQuoteResult = { quote: StepQuote } | { error: string; retry: boolean };

/**
 * Ask the route that will run this render what it costs (free). A refusal
 * about the request itself (a missing voice, a workspace mismatch) stands;
 * a dropped connection, a busy route or a server failure is worth asking
 * again. An aborted request rejects, so the caller can drop it.
 */
export async function fetchStepQuote(render: StepRender, scope: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<StepQuoteResult> {
  let response: Response;
  try {
    response = await request(render.quoteUrl, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", ...(scope ? { "X-Workbench-Scope": scope } : {}) },
      body: JSON.stringify(render.url === "/api/audio" ? { ...render.body, quoteOnly: true } : render.body),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { error: "This step could not be priced. Check the connection.", retry: true };
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value && typeof value.error === "string" && value.error ? value.error : "This step could not be priced.";
    return { error, retry: response.status >= 500 || response.status === 429 };
  }
  const quote = readStepQuote(value, render);
  return quote ? { quote } : { error: "This step's price came back incomplete.", retry: true };
}

/** True when a fresh quote would charge something other than the one shown. */
export const quoteMoved = (shown: StepQuote, fresh: StepQuote) =>
  shown.estimatedCredits !== fresh.estimatedCredits || shown.price !== fresh.price;

type Priced = Pick<Step, "status" | "estCostUsd" | "estCredits" | "billedCredits">;

/**
 * A step's price in the workspace's own unit (lib/price.ts), or null when
 * nothing has priced it yet — which is never shown as free.
 *
 * In credits that is the server's figure, never a conversion here: the credits
 * the ledger billed for a step that ran, the checkpoint's live admission quote
 * when there is one, otherwise the estimate the server converted at the
 * engine's margin. In dollars it is the vendor's dollars the workspace pays.
 * A connected-account step is not in this unit at all; the caller prices it
 * in connected credits.
 */
export function stepPrice(step: Priced, inCredits: boolean, live: StepQuote | null = null): number | null {
  if (inCredits && step.status === "done" && typeof step.billedCredits === "number") return step.billedCredits;
  if (live) return live.price;
  if (inCredits) return typeof step.estCredits === "number" ? step.estCredits : null;
  return step.estCostUsd ?? null;
}

/** A plan's priced total, and how many of its steps nothing has priced yet. */
export function planTotal(prices: (number | null)[]): { total: number; unpriced: number } {
  let total = 0, unpriced = 0;
  for (const p of prices) {
    if (p === null) unpriced++;
    else total += p;
  }
  return { total, unpriced };
}

/** The paid request: the quoted body, capped at the quoted credits, and tied to the quote. */
export function approvedBody(render: StepRender, quote: StepQuote): Record<string, unknown> {
  return {
    ...render.body,
    maxCredits: quote.estimatedCredits,
    ...(render.url === "/api/generate" && quote.fingerprint ? { quoteFingerprint: quote.fingerprint } : {}),
  };
}
