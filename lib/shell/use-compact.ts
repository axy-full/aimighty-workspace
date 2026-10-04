"use client";
import { useSyncExternalStore } from "react";

/**
 * The phone's compact chrome (components/graphite/phone.css): below 768px the project
 * switcher and the page strip share the top bar's second row, so the shell
 * renders them there instead of in the stage. A short landscape touch screen
 * uses one row. The query is the stylesheet's.
 */
export const COMPACT_QUERY = "(max-width: 767px), (min-width: 768px) and (max-height: 500px) and (pointer: coarse)";

function subscribe(notify: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(COMPACT_QUERY).matches, () => false);
}
