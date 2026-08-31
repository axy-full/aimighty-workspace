"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny fetch hook with optional polling. Avoids pulling in SWR for four screens.
 *
 * Responses are applied only if they belong to the newest request for the
 * newest url — an in-flight fetch for a previous bin (or an older poll tick
 * finishing after a newer one) must never overwrite fresher data.
 */
export function useApi<T>(url: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const alive = useRef(true);
  // Monotonic request counter: only the newest request may apply its result,
  // which covers both an old poll tick finishing late and an in-flight fetch
  // for a previous bin resolving after the switch.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!url) return;
    const mySeq = ++seq.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const json = await res.json();
      if (!alive.current || mySeq !== seq.current) return;
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setData(json as T);
      setError(null);
    } catch (e) {
      if (alive.current && mySeq === seq.current) {
        setError((e as Error).message);
      }
    } finally {
      if (alive.current && mySeq === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    // Every setState in refresh() sits behind an await, so nothing is set
    // synchronously here — the rule just can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  /**
   * Polling stops while the tab is hidden and catches up the moment it comes
   * back. A workspace left open in a background tab used to keep asking the
   * database questions all night; now a backgrounded tab costs nothing, which
   * is most of the saving in a team that lives with the app open.
   */
  useEffect(() => {
    if (!intervalMs || !url) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => { timer ??= setInterval(refresh, intervalMs); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

    const onVisibility = () => {
      if (document.hidden) stop();
      else { refresh(); start(); }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [intervalMs, refresh, url]);

  return { data, error, loading, refresh };
}
