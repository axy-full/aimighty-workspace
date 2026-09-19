'use client';
import { useEffect, useMemo, useState } from "react";
import { ShotEstimator, type ShotEstimate, type ShotEstimateInput } from "./cost";

/** One estimator per tab, so every row and the Inspector share the cache. */
export const sharedShotEstimator = new ShotEstimator();
const shared = sharedShotEstimator;

/**
 * The live credit estimate for one shot's settings.
 *
 * Calls GET /api/workbench/engines (debounced 250ms, aborted when the
 * settings change or the component unmounts, cached by settings key).
 * `tokens` is the metered frame-token count by the server's own formula,
 * present for token-billed engines even while the credits load.
 *
 * It prices the shot's own settings only: bound reference videos add input
 * seconds, so the dispatch gate must still take the full quote
 * (POST /api/generate/quote / the engines route with references) before
 * anything is submitted.
 */
export function useShotEstimate(input: ShotEstimateInput, options: { estimator?: ShotEstimator } = {}): ShotEstimate {
  const estimator = options.estimator ?? shared;
  const { engine, durationS, ratio, resolution } = input;
  const settings = useMemo(() => ({ engine, durationS, ratio, resolution }), [engine, durationS, ratio, resolution]);
  const key = estimator.keyOf(settings);
  const [result, setResult] = useState<{ key: string; value: ShotEstimate } | null>(null);
  useEffect(() => estimator.request(settings, (value) => setResult({ key, value })), [estimator, settings, key]);
  return result?.key === key ? result.value : estimator.peek(settings);
}
