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
/** What a failed Enhance says first, whatever went wrong (the owner's words, 16 Oct 2026). */
export const ENHANCE_COULDNT = "Couldn't enhance this time.";
/**
 * The whole line when the press is known to have cost nothing: the server said so (`nothingBilled`, which every enhancer failure carries, lib/paidText.ts
 * `freeOnFailure`), or a press cut off or timed out was collected again by its key and the server's saved ending said so. The no-charge sentence is never
 * said on the client's own guess (pinned word for word in tests/unit/enhanceStableKey.spec.ts and tests/unit/enhance-client.spec.ts).
 */
export const ENHANCE_FAILED = `${ENHANCE_COULDNT} Nothing was charged.`;
/** A failure whose estimate the server says it holds for now (a charge it cannot yet settle): its own figure, never one of ours. */
export const enhanceHeldLine = (credits: number): string => `${ENHANCE_COULDNT} ${credits} cr held for now; it comes back to your balance automatically, usually within a few hours.`;
/** How long the first words may take to arrive (a little past the server's own 8 s deadline, lib/paidText.ts ENHANCE_DEADLINE_MS, so words served at that deadline still arrive). */
export const ENHANCE_CLIENT_MS = 10_000;
/** Once words are coming, the longest the stream may go quiet before it counts as cut off. */
export const ENHANCE_IDLE_MS = 5_000;
/** A press that ended without its answer (cut off, quiet, timed out, a lost reply) is asked for again under its key: how long that asking may take, and how often a claim still being settled is asked again. */
export const ENHANCE_COLLECT_MS = 3_000;
export const ENHANCE_COLLECT_TRIES = 6;
export const ENHANCE_COLLECT_GAP_MS = 400;

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
type Timing = number | { firstMs: number; idleMs: number; collectMs?: number; collectGapMs?: number };
type Line = { t?: unknown; done?: unknown; prompt?: unknown; provider?: unknown; error?: unknown; nothingBilled?: unknown; heldCredits?: unknown };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Press = { scope: string | null | undefined; body: string; credits: number };

/** The line for a failed press, with the server's own word on the bill when it gave one (never a guess or a figure of ours). */
function failureLine(said: { nothingBilled?: unknown; heldCredits?: unknown } | null | undefined): string {
  if (said?.nothingBilled === true) return ENHANCE_FAILED;
  if (typeof said?.heldCredits === "number" && Number.isFinite(said.heldCredits) && said.heldCredits > 0) return enhanceHeldLine(said.heldCredits);
  return ENHANCE_COULDNT;
}

/**
 * One press. The rewrite streams back (`stream: true` when the screen shows words as they come, `hooks.onWords`); the first words are waited for
 * `firstMs`, a quiet stream `idleMs`. Cancel (`hooks.signal`) ends it at once, says nothing, and keeps the key: the server settles a press it never
 * finished delivering at nothing (lib/enhanceStream.ts).
 *
 * A streamed press that ends without its answer and without the person stopping it (cut off midway, gone quiet, no first word in time, a reply nobody
 * could read) is not guessed at: it is sent once more under the same key, which never runs or charges anything twice, and what the server settled is
 * what is said. A saved answer is the rewrite (paid once, delivered now); a saved free ending is "Nothing was charged."; a claim still being settled is
 * asked again a few times (then ENHANCE_PENDING); anything else is ENHANCE_LOST, and the key is kept for the next press to collect.
 *
 * A press that asks for the whole answer (no `onWords`) is charged as soon as the writer answers, so it is never asked again on its own: a lost reply
 * says ENHANCE_LOST and the next press collects it by the key.
 */
export async function pressEnhance(
  fetcher: Fetcher,
  press: Press,
  keys: EnhanceKeys = enhanceKeys,
  clock: () => number = Date.now,
  timing: Timing = { firstMs: ENHANCE_CLIENT_MS, idleMs: ENHANCE_IDLE_MS },
  hooks: EnhanceHooks = {},
): Promise<EnhancePress> {
  const signature = enhanceSignature(press.scope, press.body, press.credits);
  const t = typeof timing === "number" ? { firstMs: timing, idleMs: timing } : timing;
  const collectMs = t.collectMs ?? ENHANCE_COLLECT_MS;
  const gapMs = t.collectGapMs ?? ENHANCE_COLLECT_GAP_MS;
  const cancelled = (): EnhancePress | null => hooks.signal?.aborted ? { ok: false, error: "", cancelled: true } : null;
  const go = (key: string, collecting: boolean) => attempt(fetcher, press, key, signature, keys, clock, hooks, collecting ? collectMs : t.firstMs, t.idleMs);
  const unsure = (pending?: true): EnhancePress => cancelled() ?? { ok: false, error: pending ? ENHANCE_PENDING : ENHANCE_LOST };
  try {
    let out = await go(keys.take(signature, clock()), false);
    /* The key replayed a press of these words that ended free (cancelled, cut off): that press is over, so this one is made, once, under a fresh key. */
    if (out.kind === "replayed-free") { keys.release(signature); out = await go(keys.take(signature, clock()), false); }
    if (out.kind === "done") return out.press;
    if (out.kind === "replayed-free") { keys.release(signature); return { ok: false, error: ENHANCE_FAILED }; }
    if (!hooks.onWords) return unsure(out.pending);
    /* A streamed press ended without its answer: what did the server settle? Asked under the same key; a claim still being settled is asked again. */
    let pending = out.pending;
    for (let i = 0; i < ENHANCE_COLLECT_TRIES; i++) {
      if (cancelled()) return unsure();
      if (i > 0 || pending) await new Promise((resolve) => setTimeout(resolve, gapMs));
      const again = await go(keys.take(signature, clock()), true);
      if (again.kind === "done") return again.press;
      if (again.kind === "replayed-free") { keys.release(signature); return { ok: false, error: ENHANCE_FAILED }; }
      pending = again.pending;
      if (!pending) break;
    }
    return unsure(pending);
  } catch {
    return unsure();
  }
}

/** One request under a key: its answer (`done`), a replay of a free ending (`replayed-free`), or no answer to go by (`unsure`; `pending` while the claim is being settled). */
type Attempt = { kind: "done"; press: EnhancePress } | { kind: "replayed-free" } | { kind: "unsure"; pending?: true };

async function attempt(
  fetcher: Fetcher, press: Press, key: string, signature: string, keys: EnhanceKeys, clock: () => number, hooks: EnhanceHooks, firstMs: number, idleMs: number,
): Promise<Attempt> {
  const patience = new AbortController();
  let timer = setTimeout(() => patience.abort(), firstMs);
  const patient = () => { clearTimeout(timer); timer = setTimeout(() => patience.abort(), idleMs); };
  const signal = hooks.signal ? AbortSignal.any([patience.signal, hooks.signal]) : patience.signal;
  const stopped = (): Attempt => hooks.signal?.aborted ? { kind: "done", press: { ok: false, error: "", cancelled: true } } : { kind: "unsure" };
  try {
    let response: Response;
    try {
      response = await fetcher("/api/prompt/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        /* A screen that shows the words as they come asks for the stream (and the server then charges only once the last word is out); one that only wants the answer gets it whole. */
        body: JSON.stringify({ ...JSON.parse(press.body), maxCredits: press.credits, ...(hooks.onWords ? { stream: true } : {}) }),
        signal,
      });
    } catch {
      return stopped();
    }
    if (response.ok && /ndjson/i.test(response.headers.get("Content-Type") ?? "")) return await readStream(response, signature, keys, signal, patient, hooks, stopped);
    const json = await response.json().catch(() => null) as ({ prompt?: string; provider?: EnhancerProvider; error?: string; pending?: boolean } & Line) | null;
    if (hooks.signal?.aborted) return stopped();
    if (response.status === 409 && json?.pending === true && response.headers.get("Idempotency-Status") !== "complete") {
      if (response.headers.get("Idempotency-Replayed") !== "true") return { kind: "unsure", pending: true };
      if (!keys.abandoned(signature, clock())) return { kind: "unsure", pending: true };
      keys.release(signature);
      return { kind: "done", press: { ok: false, error: ENHANCE_ABANDONED } };
    }
    /* No readable answer (a host's error page, a body cut short): unsure, and the key is kept. */
    if (!json) return { kind: "unsure" };
    const complete = response.headers.get("Idempotency-Status") === "complete";
    if (complete && response.headers.get("Idempotency-Replayed") === "true" && !response.ok && json.nothingBilled === true) return { kind: "replayed-free" };
    /* The server's saved answer, read: success or refusal, the next press is a new one. */
    if (complete) keys.release(signature);
    if (response.ok && json.prompt && json.provider) return { kind: "done", press: { ok: true, prompt: json.prompt, provider: json.provider } };
    return { kind: "done", press: { ok: false, error: failureLine(json) } };
  } finally {
    clearTimeout(timer);
  }
}

/** The words, one JSON line each (`{"t":"word "}`), then `{"done":true,"prompt","provider"}` once the workspace has been charged; or `{"error"}`. A stream that ends otherwise ended without its answer. */
async function readStream(
  response: Response, signature: string, keys: EnhanceKeys, signal: AbortSignal, patient: () => void, hooks: EnhanceHooks, stopped: () => Attempt,
): Promise<Attempt> {
  const reader = response.body?.getReader();
  if (!reader) return { kind: "unsure" };
  const decoder = new TextDecoder();
  let buffer = "";
  let soFar = "";
  /* Cancel, or the patience running out, ends the read whatever the transport does with the body. */
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      patient();
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!raw) continue;
        let line: Line;
        try { line = JSON.parse(raw) as Line; } catch { continue; }
        if (typeof line.t === "string") { soFar += line.t; hooks.onWords?.(soFar); }
        else if (line.done === true && typeof line.prompt === "string" && typeof line.provider === "string") { keys.release(signature); return { kind: "done", press: { ok: true, prompt: line.prompt, provider: line.provider as EnhancerProvider } }; }
        else if (typeof line.error === "string") { keys.release(signature); return { kind: "done", press: { ok: false, error: failureLine(line) } }; }
      }
    }
  } catch {
    return stopped();
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => {});
  }
  /* The stream ended without its last line. */
  return stopped();
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
