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
/**
 * What a failed Enhance says, whatever went wrong (a timeout, a provider error, a missing key, a stream cut off): the owner's words, 16 Oct 2026. They
 * are true because the server settles every failed press at nothing (lib/paidText.ts `freeOnFailure`) and the typed words come back untouched. A reply
 * that never arrived is the one case the client cannot vouch for: that says ENHANCE_LOST.
 */
export const ENHANCE_FAILED = "Couldn't enhance this time. Nothing was charged.";
/** How long the first words may take to arrive (a little past the server's own 8 s deadline, lib/paidText.ts ENHANCE_DEADLINE_MS, so words served at that deadline still arrive). */
export const ENHANCE_CLIENT_MS = 10_000;
/** Once words are coming, the longest the stream may go quiet before it counts as cut off. */
export const ENHANCE_IDLE_MS = 5_000;

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

export type EnhancePress = { ok: true; prompt: string; provider: EnhancerProvider } | { ok: false; error: string; cancelled?: true };
/** What a press tells its screen as it goes: the words so far (the whole rewrite so far, not the latest word), and the person's wish to stop. */
export type EnhanceHooks = { onWords?: (soFar: string) => void; signal?: AbortSignal };
type Timing = number | { firstMs: number; idleMs: number };
type Line = { t?: unknown; done?: unknown; prompt?: unknown; provider?: unknown; error?: unknown };

export async function pressEnhance(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  press: { scope: string | null | undefined; body: string; credits: number },
  keys: EnhanceKeys = enhanceKeys,
  clock: () => number = Date.now,
  timing: Timing = { firstMs: ENHANCE_CLIENT_MS, idleMs: ENHANCE_IDLE_MS },
  hooks: EnhanceHooks = {},
): Promise<EnhancePress> {
  const signature = enhanceSignature(press.scope, press.body, press.credits);
  const key = keys.take(signature, clock());
  const { firstMs, idleMs } = typeof timing === "number" ? { firstMs: timing, idleMs: timing } : timing;
  /* Past the client's patience the press is given up on and the words stay as typed. The key is still held: pressed again, the same press
     collects the server's saved answer instead of paying twice. */
  const patience = new AbortController();
  let timer = setTimeout(() => patience.abort(), firstMs);
  const patient = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => patience.abort(), ms); };
  const signal = hooks.signal ? AbortSignal.any([patience.signal, hooks.signal]) : patience.signal;
  try {
    return await sent(fetcher, press, key, signature, keys, clock, false, { signal, wished: hooks.signal, patience: patience.signal, patient, idleMs, onWords: hooks.onWords });
  } catch {
    return hooks.signal?.aborted ? { ok: false, error: "", cancelled: true } : { ok: false, error: ENHANCE_FAILED };
  } finally {
    clearTimeout(timer);
  }
}

async function sent(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  press: { scope: string | null | undefined; body: string; credits: number },
  key: string, signature: string, keys: EnhanceKeys, clock: () => number, retried: boolean,
  how: { signal: AbortSignal; wished?: AbortSignal; patience: AbortSignal; patient: (ms: number) => void; idleMs: number; onWords?: (soFar: string) => void },
): Promise<EnhancePress> {
  const stopped = (): EnhancePress => how.wished?.aborted ? { ok: false, error: "", cancelled: true } : how.patience.aborted ? { ok: false, error: ENHANCE_FAILED } : { ok: false, error: ENHANCE_LOST };
  let response: Response;
  try {
    response = await fetcher("/api/prompt/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      /* A screen that shows the words as they come asks for the stream; one that only wants the answer gets it whole. */
      body: JSON.stringify({ ...JSON.parse(press.body), maxCredits: press.credits, ...(how.onWords ? { stream: true } : {}) }),
      signal: how.signal,
    });
  } catch {
    /* Cancelled by the person, or given up on past the patience: the key stays held (the press is collected again by it). Any other break is a lost reply. */
    return stopped();
  }
  if (response.ok && /ndjson/i.test(response.headers.get("Content-Type") ?? "")) return await readStream(response, press, signature, keys, how, stopped);
  const json = await response.json().catch(() => null) as { prompt?: string; provider?: EnhancerProvider; error?: string; pending?: boolean } | null;
  if (response.headers.get("Idempotency-Status") === "complete") {
    /* The server's saved answer, read: success or refusal, the next press is a new one. Unread, it is collected by the same key. */
    if (!json) return how.signal.aborted ? stopped() : { ok: false, error: ENHANCE_LOST };
    keys.release(signature);
  } else if (response.status === 409 && json?.pending === true) {
    if (!keys.abandoned(signature, clock())) return { ok: false, error: ENHANCE_PENDING };
    keys.release(signature);
    return { ok: false, error: ENHANCE_ABANDONED };
  }
  if (how.signal.aborted) return stopped();
  /* The key replayed a press that was cut off or cancelled and was settled at nothing: that press is over, so this one is made again, once, under a fresh key. */
  if (!retried && response.headers.get("Idempotency-Replayed") === "true" && !response.ok && (json as { nothingBilled?: unknown } | null)?.nothingBilled === true) {
    keys.release(signature);
    return sent(fetcher, press, keys.take(signature, clock()), signature, keys, clock, true, how);
  }
  if (response.ok && json?.prompt && json.provider) return { ok: true, prompt: json.prompt, provider: json.provider };
  /* An answer from the server that is not an enhancement (a refusal, a missing key, a writer that answered nothing): the server settled it at nothing. A reply with no readable answer is a lost one. */
  return json ? { ok: false, error: ENHANCE_FAILED } : { ok: false, error: ENHANCE_LOST };
}

/** The words, one JSON line each (`{"t":"word "}`), then `{"done":true,"prompt","provider"}` once the workspace has been charged; or `{"error"}`. A stream that ends otherwise was cut off. */
async function readStream(
  response: Response,
  press: { scope: string | null | undefined; body: string; credits: number },
  signature: string, keys: EnhanceKeys,
  how: { signal: AbortSignal; patient: (ms: number) => void; idleMs: number; onWords?: (soFar: string) => void },
  stopped: () => EnhancePress,
): Promise<EnhancePress> {
  void press;
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, error: ENHANCE_FAILED };
  const decoder = new TextDecoder();
  let buffer = "";
  let soFar = "";
  /* Cancel, or the patience running out, ends the read whatever the transport does with the body. */
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  how.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      how.patient(how.idleMs);
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!raw) continue;
        let line: Line;
        try { line = JSON.parse(raw) as Line; } catch { continue; }
        if (typeof line.t === "string") { soFar += line.t; how.onWords?.(soFar); }
        else if (line.done === true && typeof line.prompt === "string" && typeof line.provider === "string") { keys.release(signature); return { ok: true, prompt: line.prompt, provider: line.provider as EnhancerProvider }; }
        else if (typeof line.error === "string") { keys.release(signature); return { ok: false, error: ENHANCE_FAILED }; }
      }
    }
  } catch {
    /* A break after words have come is a stream cut off (the server abandons it at nothing); before any word it is a lost reply, collected again by the key. */
    return soFar && !how.signal.aborted ? { ok: false, error: ENHANCE_FAILED } : stopped();
  } finally {
    how.signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
  /* The stream ended without its last line: cut off. The server abandons such an answer at nothing; the key replays that. */
  return how.signal.aborted ? stopped() : { ok: false, error: ENHANCE_FAILED };
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
  /** What the press in flight tells its screen (the words so far) and listens for (Cancel): set by `attach` before `run`. */
  private hooks: EnhanceHooks = {};
  attach(hooks: EnhanceHooks): void { this.hooks = hooks; }
  private inFlight = new Map<string, Promise<EnhancePress>>();
  constructor(private readonly keys: EnhanceKeys = enhanceKeys, private readonly clock: () => number = Date.now, private readonly timing: Timing = { firstMs: ENHANCE_CLIENT_MS, idleMs: ENHANCE_IDLE_MS }) {}
  get busy(): boolean { return this.inFlight.size > 0; }
  async run(
    fetcher: (url: string, init: RequestInit) => Promise<Response>,
    press: { scope: string | null | undefined; body: string; credits: number },
    now: () => EnhanceNow,
    hooks: EnhanceHooks = this.hooks,
  ): Promise<EnhanceOutcome> {
    const signature = enhanceSignature(press.scope, press.body, press.credits);
    let pressing = this.inFlight.get(signature);
    if (!pressing) {
      const started = pressEnhance(fetcher, press, this.keys, this.clock, this.timing, hooks);
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
