/**
 * A call's own time limit, joined with the caller's wish to drop it: the signal ends at `ms`, or the moment `signal` does (a person pressed Cancel).
 * Pure; no imports.
 */
export function within(ms: number, signal?: AbortSignal): AbortSignal {
  const limit = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([limit, signal]) : limit;
}
