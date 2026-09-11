"use client";

import { useSyncExternalStore } from "react";

/**
 * Below 768 (design/particl-v2-mobile/README.md: the breakpoint). One
 * subscription to the media query, read the same way on the server (false)
 * and on the client, so nothing hydrates differently than it rendered.
 */
const QUERY = "(max-width: 767px)";
let mq: MediaQueryList | null = null;
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  if (!mq) { mq = window.matchMedia(QUERY); mq.addEventListener("change", () => listeners.forEach((l) => l())); }
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const snap = () => (typeof window === "undefined" ? false : (mq ?? window.matchMedia(QUERY)).matches);

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snap, () => false);
}
