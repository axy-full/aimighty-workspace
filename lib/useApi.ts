"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./session";

/**
 * Tiny fetch hook with optional polling. Avoids pulling in SWR for four screens.
 *
 * Responses are applied only if they belong to the newest request for the
 * newest url — an in-flight fetch for a previous bin (or an older poll tick
 * finishing after a newer one) must never overwrite fresher data.
 */
export function useApi<T>(url: string | null, intervalMs = 0) {
  /* A signed-out visitor is browsing the interface, not using it. Every one
     of these endpoints would answer 401, so asking is forty pointless
     requests and forty error states for someone who has done nothing wrong.
     `locked` is what the screens render a "sign in to see this" panel from.
     It is a courtesy, not a guard: the guard is the server's 401. */
  const { signedIn } = useSession();
  const locked = !signedIn;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The HTTP status of the last failure, when there was one. */
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Monotonic request counter: only the newest request may apply its result,
  // which covers both an old poll tick finishing late and an in-flight fetch
  // for a previous bin resolving after the switch.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (!url || !signedIn) return;
    const mySeq = ++seq.current;
    try {
      const res = await fetch(url, { cache: "no-store" });
      // A 502 from the edge arrives as an HTML page, and res.json() on that
      // throws a SyntaxError that would replace the real problem.
      const json = await res.json().catch(() => ({} as { error?: string }));
      if (!alive.current || mySeq !== seq.current) return;
      if (!res.ok) {
        const err = new Error(json.error ?? `Request failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      setData(json as T);
      setError(null);
      setStatus(null);
    } catch (e) {
      if (alive.current && mySeq === seq.current) {
        const err = e as Error & { status?: number };
        setError(err.message);
        setStatus(err.status ?? null);
        /* A session that has lapsed, or a member an admin has just disabled,
           answers 401 to every poll. The redirect lives in the server layout,
           which a client-side navigation never re-runs — so without this the
           tab simply sits on a spinner for ever. A HARD navigation, so the
           layout actually runs. Only on 401: a network blip or an unreadable
           body lands in this same catch with no status, and must never bounce
           a working session out of the app. */
        /* Only a session that HAS lapsed gets bounced. A visitor who was
           never signed in is browsing on purpose, and throwing them at the
           login page the moment a panel polls would make the public
           interface impossible to look at. */
        if (err.status === 401 && signedIn && typeof window !== "undefined" &&
            !window.location.pathname.startsWith("/login")) {
          // A HARD navigation on purpose: the auth check lives in the server
          // layout, and router.push would re-enter the same client tree
          // without ever re-running it.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign("/login");
        }
      }
    } finally {
      if (alive.current && mySeq === seq.current) setLoading(false);
    }
  }, [url, signedIn]);

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
    if (!intervalMs || !url || !signedIn) return;
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
  }, [intervalMs, refresh, url, signedIn]);

  return { data, error, status, loading, locked, refresh };
}
