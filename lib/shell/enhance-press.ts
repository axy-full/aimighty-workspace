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
): Promise<EnhancePress> {
  const signature = enhanceSignature(press.scope, press.body, press.credits);
  const key = keys.take(signature, clock());
  let response: Response;
  try {
    response = await fetcher("/api/prompt/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ ...JSON.parse(press.body), maxCredits: press.credits }),
    });
  } catch {
    return { ok: false, error: ENHANCE_LOST };
  }
  const json = await response.json().catch(() => null) as { prompt?: string; provider?: EnhancerProvider; error?: string; pending?: boolean } | null;
  if (response.headers.get("Idempotency-Status") === "complete") {
    /* The server's saved answer, read: success or refusal, the next press is a new one. Unread, it is collected by the same key. */
    if (!json) return { ok: false, error: ENHANCE_LOST };
    keys.release(signature);
  } else if (response.status === 409 && json?.pending === true) {
    if (!keys.abandoned(signature, clock())) return { ok: false, error: ENHANCE_PENDING };
    keys.release(signature);
    return { ok: false, error: ENHANCE_ABANDONED };
  }
  if (!response.ok || !json?.prompt || !json.provider) return { ok: false, error: json?.error ?? ENHANCE_NO_ANSWER };
  return { ok: true, prompt: json.prompt, provider: json.provider };
}
