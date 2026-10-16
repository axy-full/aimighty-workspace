import type { EnhancerProvider } from "./enhancer";

/**
 * One Enhance press against POST /api/prompt/enhance, and the Idempotency-Key
 * it is sent under (docs/long-flows.md › C4).
 *
 * The key is held for one exact press: the same account and workspace (the
 * request scope), the same words and settings (the request body) and the same
 * approved price. Pressing again while that press's answer is unknown — the
 * reply was lost, the host cut the request, the body could not be read — sends
 * the same key, so the route answers from its saved claim and the workspace is
 * not charged twice. The key is let go once an answer the server saved
 * (`Idempotency-Status: complete`) has been read, or when anything in the
 * press changes; the next press then gets a fresh key and is a new charge.
 *
 * The key itself is random, never derived from the words: the server keys
 * claims by workspace and account as well, and a key held for one scope is
 * never sent from another (the scope is part of what it is held for).
 */

/** A held press still answered "being accepted" this long after it was first sent did not finish: the route answers within 120 s on every host. */
export const ENHANCE_KEY_ABANDON_MS = 10 * 60_000;

export const ENHANCE_LOST = "The enhancer's answer did not arrive. Press Enhance again to collect it; it will not be charged twice.";
export const ENHANCE_PENDING = "Your last press is still being answered. Press Enhance again in a moment; it will not be charged twice.";
export const ENHANCE_ABANDONED = "Your last press did not finish. Press Enhance again to start a new one.";
export const ENHANCE_NO_ANSWER = "The enhancer did not answer. Your prompt is unchanged.";
/** The line every failed Enhance starts with (timeout, provider error, no key, a lost reply): the typed words stay, and Make sends them as written. */
export const ENHANCE_FALLBACK = "Couldn't enhance; used your prompt as written";
/** With what the server settled (rule 14): nothing billed, or the held estimate in credits. Said only when the server said it. */
export const ENHANCE_NOTHING_BILLED = `${ENHANCE_FALLBACK}. Nothing billed.`;
export const enhanceHeldLine = (credits: number): string => `${ENHANCE_FALLBACK}. ${credits} cr held, returned if the writer never answered.`;
/** The client's patience with the enhancer, a quote or a run: a little longer than the server's own 8 s deadline (lib/paidText.ts ENHANCE_DEADLINE_MS), so an answer served at that deadline still arrives. */
export const ENHANCE_CLIENT_MS = 10_000;

type Held = { signature: string; key: string; firstSentAt: number };

/** The one press whose answer is still unknown, if any. */
export class EnhanceKeys {
  private held: Held | null = null;
  constructor(private readonly mint: () => string = () => `enhance-${crypto.randomUUID()}`) {}
  /** The key for this press: the held one when it is the same press, else a fresh one (held from now on). */
  take(signature: string, at: number): string {
    if (this.held?.signature !== signature) this.held = { signature, key: this.mint(), firstSentAt: at };
    return this.held.key;
  }
  /** The press's answer is known: its key is never sent again. */
  release(signature: string): void {
    if (this.held?.signature === signature) this.held = null;
  }
  abandoned(signature: string, at: number): boolean {
    return this.held?.signature === signature && at - this.held.firstSentAt >= ENHANCE_KEY_ABANDON_MS;
  }
}

/** The page's held press: one per document, so a panel that closes and reopens still recovers it. */
export const enhanceKeys = new EnhanceKeys();

/** What one press is: who sends it, where, the exact request and the price approved. */
export function enhanceSignature(scope: string | null | undefined, body: string, credits: number): string {
  return JSON.stringify([scope ?? "", body, credits]);
}

export type EnhancePress = { ok: true; prompt: string; provider: EnhancerProvider } | { ok: false; error: string };

export async function pressEnhance(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  press: { scope: string | null | undefined; body: string; credits: number },
  keys: EnhanceKeys = enhanceKeys,
  clock: () => number = Date.now,
  timeoutMs: number = ENHANCE_CLIENT_MS,
): Promise<EnhancePress> {
  const signature = enhanceSignature(press.scope, press.body, press.credits);
  const key = keys.take(signature, clock());
  /* Past the client's patience the press is given up on and the words stay as typed. The key is still held: pressed again, the same press
     collects the server's saved answer instead of paying twice. */
  const patience = new AbortController();
  const timer = setTimeout(() => patience.abort(), timeoutMs);
  try {
    return await sent(fetcher, press, key, signature, keys, clock, patience.signal);
  } catch {
    return { ok: false, error: ENHANCE_FALLBACK };
  } finally {
    clearTimeout(timer);
  }
}

async function sent(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  press: { scope: string | null | undefined; body: string; credits: number },
  key: string, signature: string, keys: EnhanceKeys, clock: () => number, signal: AbortSignal,
): Promise<EnhancePress> {
  let response: Response;
  try {
    response = await fetcher("/api/prompt/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ ...JSON.parse(press.body), maxCredits: press.credits }),
      signal,
    });
  } catch {
    /* Given up on past the patience: the one line. Any other break is a lost reply, whose press can be collected again by its key. */
    return { ok: false, error: signal.aborted ? ENHANCE_FALLBACK : ENHANCE_LOST };
  }
  const json = await response.json().catch(() => null) as { prompt?: string; provider?: EnhancerProvider; error?: string; pending?: boolean; nothingBilled?: unknown; heldCredits?: unknown } | null;
  if (response.headers.get("Idempotency-Status") === "complete") {
    /* The server's saved answer, read: success or refusal, the next press is a new one. Unread, it is collected by the same key. */
    if (!json) return { ok: false, error: ENHANCE_FALLBACK };
    keys.release(signature);
  } else if (response.status === 409 && json?.pending === true) {
    if (!keys.abandoned(signature, clock())) return { ok: false, error: ENHANCE_PENDING };
    keys.release(signature);
    return { ok: false, error: ENHANCE_ABANDONED };
  }
  /* Whatever the reason (a refusal, a missing key, a writer that answered nothing), the person is told the one line and keeps their words. */
  if (!response.ok || !json?.prompt || !json.provider) return { ok: false, error: failureLine(json) };
  return { ok: true, prompt: json.prompt, provider: json.provider };
}

/** The line for a failed press, with the server's own word on the bill when it gave one (never a figure of ours). */
function failureLine(json: { nothingBilled?: unknown; heldCredits?: unknown } | null): string {
  if (json?.nothingBilled === true) return ENHANCE_NOTHING_BILLED;
  if (typeof json?.heldCredits === "number" && Number.isFinite(json.heldCredits) && json.heldCredits > 0) return enhanceHeldLine(json.heldCredits);
  return ENHANCE_FALLBACK;
}

/** A press whose words, settings or account changed while it was on its way: its answer is for words no longer there. */
export type EnhanceOutcome = EnhancePress | { ok: false; stale: true };
/** What the composer holds now: compared with a press when its answer arrives. */
export type EnhanceNow = { scope: string | null | undefined; body: string } | null;

/**
 * The presses of one Enhance control. A press made while the SAME press
 * (same account, workspace, words, settings and price) is on its way shares
 * that press's answer: nothing is sent twice. A press for anything else is a
 * press of its own. And an answer is handed back only while the composer
 * still holds the words it was asked for: one that arrives after the words
 * were replaced comes back `stale`, never to be applied over the new words.
 */
export class EnhanceRuns {
  private inFlight = new Map<string, Promise<EnhancePress>>();
  constructor(private readonly keys: EnhanceKeys = enhanceKeys, private readonly clock: () => number = Date.now, private readonly timeoutMs: number = ENHANCE_CLIENT_MS) {}
  get busy(): boolean { return this.inFlight.size > 0; }
  async run(
    fetcher: (url: string, init: RequestInit) => Promise<Response>,
    press: { scope: string | null | undefined; body: string; credits: number },
    now: () => EnhanceNow,
  ): Promise<EnhanceOutcome> {
    const signature = enhanceSignature(press.scope, press.body, press.credits);
    let pressing = this.inFlight.get(signature);
    if (!pressing) {
      const started = pressEnhance(fetcher, press, this.keys, this.clock, this.timeoutMs);
      pressing = started;
      this.inFlight.set(signature, started);
      void started.finally(() => { if (this.inFlight.get(signature) === started) this.inFlight.delete(signature); });
    }
    const answer = await pressing;
    const held = now();
    if (!held || (held.scope ?? "") !== (press.scope ?? "") || held.body !== press.body) return { ok: false, stale: true };
    return answer;
  }
}
