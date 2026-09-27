"use client";
import { useSyncExternalStore } from "react";

/**
 * The phone's compact chrome (app/phone-chrome.css): below 768px the project
 * switcher and the page strip share the top bar's second row, so the shell
 * renders them there instead of in the stage. The query is the stylesheet's.
 */
export const COMPACT_QUERY = "(max-width: 767px)";

function subscribe(notify: () => void) {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(COMPACT_QUERY).matches, () => false);
}
