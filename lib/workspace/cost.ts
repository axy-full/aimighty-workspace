import { billingOf, estimateTokens } from "../models";
import { resolveShotSettings, type ShotSettings } from "./engines";

/**
 * What a Rig shot costs, as the person is shown it: CREDITS from the live
 * quote endpoint (GET /api/workbench/engines → quoteWorkbenchMedia), never a
 * browser-side dollar figure (workspace brief, owner decision 4).
 *
 * The token count beside it is the frame-token count the vendor meters,
 * computed by the very function the server prices with
 * (lib/models.ts estimateTokens → billedFrame, each side rounded up to a
 * multiple of 16) — not the prototype's simplified 1280×720 formula. It is
 * informational and only exists for token-billed engines.
 *
 * Browser-safe: nothing here reads vendor rates or margins.
 */

export type ShotEstimateInput = { engine?: string; durationS?: number; ratio?: string; resolution?: string };
export type ShotEstimateState = "loading" | "ready" | "unavailable";
export type ShotEstimate = {
  credits: number | null;
  /** Frame tokens the engine meters, for token-billed engines only. */
  tokens?: number;
  state: ShotEstimateState;
  /** Why the figure is missing (unavailable) — null otherwise. */
  reason: string | null;
};

/** One cache key per priced combination; shared by the shot list and the hook. */
export function shotEstimateKey(settings: ShotSettings): string {
  return [settings.engine, settings.resolution, settings.ratio, settings.durationS ?? ""].join("|");
}

/** The frame tokens a render meters, by the server's own formula; undefined when the engine is not token-billed. */
export function shotTokens(settings: ShotSettings): number | undefined {
  if (billingOf(settings.engine) !== "token" || settings.durationS == null) return undefined;
  return estimateTokens(settings.resolution, settings.ratio, settings.durationS) ?? undefined;
}

/** "1,296 cr" — Western grouping regardless of the viewer's locale. */
export function formatCredits(n: number): string {
  return `${n.toLocaleString("en-US")} cr`;
}
/** "108,000 tokens" — Western grouping regardless of the viewer's locale. */
export function formatTokens(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "token" : "tokens"}`;
}

export type EstimateFetchOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  endpoint?: string;
};

/** One live quote. Throws only on abort; every other failure is an `unavailable` estimate with a reason. */
export async function fetchShotEstimate(settings: ShotSettings, options: EstimateFetchOptions = {}): Promise<ShotEstimate> {
  const tokens = shotTokens(settings);
  const base = { ...(tokens === undefined ? {} : { tokens }) };
  const query = new URLSearchParams({ model: settings.engine, resolution: settings.resolution, ratio: settings.ratio,
    ...(settings.durationS == null ? {} : { duration: String(settings.durationS) }) });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.endpoint ?? "/api/workbench/engines"}?${query}`,
      { signal: options.signal, headers: options.headers, cache: "no-store" });
  } catch (error) {
    if (options.signal?.aborted || (error as Error)?.name === "AbortError") throw error;
    return { ...base, credits: null, state: "unavailable", reason: "The estimate could not be reached. Check your connection." };
  }
  const body = (await response.json().catch(() => null)) as { credits?: unknown; error?: unknown } | null;
  if (!response.ok)
    return { ...base, credits: null, state: "unavailable", reason: typeof body?.error === "string" ? body.error : "The estimate is unavailable right now." };
  if (typeof body?.credits !== "number" || !Number.isFinite(body.credits))
    return { ...base, credits: null, state: "unavailable", reason: "This engine cannot be priced with these settings." };
  return { ...base, credits: body.credits, state: "ready", reason: null };
}

export type ShotEstimatorOptions = Omit<EstimateFetchOptions, "signal"> & {
  /** Debounce before a request leaves; default 250ms. */
  debounceMs?: number;
  /** How long a ready quote is reused; default 5 minutes. */
  ttlMs?: number;
  now?: () => number;
};

type Inflight = { promise: Promise<ShotEstimate>; controller: AbortController; refs: number };

/**
 * Debounced, abortable, cached live estimates. Framework-agnostic so it can
 * be tested without React; `useShotEstimate` is a thin subscription to it.
 * Concurrent requests for one key share a single fetch, aborted only when
 * every subscriber has gone.
 */
export class ShotEstimator {
  private cache = new Map<string, { at: number; value: ShotEstimate }>();
  private inflight = new Map<string, Inflight>();
  constructor(private options: ShotEstimatorOptions = {}) {}

  private now() { return (this.options.now ?? Date.now)(); }

  /** Normalised settings, or null when the input names no available engine. */
  settingsOf(input: ShotEstimateInput): ShotSettings | null {
    return resolveShotSettings(input);
  }

  keyOf(input: ShotEstimateInput): string {
    const settings = this.settingsOf(input);
    return settings ? shotEstimateKey(settings) : `invalid|${input.engine ?? ""}`;
  }

  private cached(key: string): ShotEstimate | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > (this.options.ttlMs ?? 300_000)) { this.cache.delete(key); return null; }
    return hit.value;
  }

  /** What to show right now, synchronously: a cached quote, or loading with the token count. */
  peek(input: ShotEstimateInput): ShotEstimate {
    const settings = this.settingsOf(input);
    if (!settings) return { credits: null, state: "unavailable", reason: "Choose an available engine for this shot." };
    const hit = this.cached(shotEstimateKey(settings));
    if (hit) return hit;
    const tokens = shotTokens(settings);
    return { credits: null, ...(tokens === undefined ? {} : { tokens }), state: "loading", reason: null };
  }

  /** Request a quote; `listener` gets the result once. Returns a cancel function (clears the debounce, aborts the fetch). */
  request(input: ShotEstimateInput, listener: (estimate: ShotEstimate) => void): () => void {
    const settings = this.settingsOf(input);
    const now = this.peek(input);
    if (!settings || now.state !== "loading") { listener(now); return () => {}; }
    const key = shotEstimateKey(settings);
    let cancelled = false, joined: Inflight | null = null;
    const timer = setTimeout(() => {
      if (cancelled) return;
      let flight = this.inflight.get(key);
      if (!flight) {
        const controller = new AbortController();
        const promise = fetchShotEstimate(settings, { ...this.options, signal: controller.signal }).then((value) => {
          if (value.state === "ready") this.cache.set(key, { at: this.now(), value });
          return value;
        }).finally(() => { if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key); });
        flight = { promise, controller, refs: 0 };
        this.inflight.set(key, flight);
      }
      flight.refs++;
      joined = flight;
      flight.promise.then((value) => { if (!cancelled) listener(value); }, () => { /* aborted */ });
    }, this.options.debounceMs ?? 250);
    return () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      if (joined && --joined.refs <= 0) {
        joined.controller.abort();
        if (this.inflight.get(key) === joined) this.inflight.delete(key);
      }
    };
  }

  /** Forget cached quotes (e.g. after a top-up or a catalogue change). */
  clear() { this.cache.clear(); }
}
