"use client";

import { useSyncExternalStore } from "react";

/**
 * Appearance: auto (follow the system), light, or dark.
 *
 * Per browser, like the composer defaults — it's a working preference, not a
 * workspace policy. "auto" means NO attribute on <html>, so the CSS media
 * query governs and a system switch takes effect live with no JavaScript in
 * the loop. A chosen theme is stamped on <html> by a script in <head> before
 * first paint (see app/layout.tsx), which is what keeps a dark-mode user from
 * seeing a white flash on every load.
 */
export type ThemePref = "auto" | "light" | "dark";

export const THEME_KEY = "aw_theme";
/* The browser chrome follows the page ground, so the status bar does not
   lie about which theme is showing. Both are the system's `page` token. */
const BAR_LIGHT = "#ECEDEF";
const BAR_DARK = "#1D1F24";

const listeners = new Set<() => void>();
let snapshot: ThemePref | null = null;

function read(): ThemePref {
  if (snapshot) return snapshot;
  let v: ThemePref = "auto";
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark") v = raw;
  } catch { /* private mode */ }
  snapshot = v;
  return v;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => { listeners.delete(cb); window.removeEventListener("storage", cb); };
}

/** What is actually showing right now, whatever the preference. */
export function resolvedTheme(pref: ThemePref = read()): "light" | "dark" {
  if (pref !== "auto") return pref;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark" : "light";
}

/** The browser chrome colour has to follow, or the status bar lies. */
function syncMeta() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    ?? (() => {
      const m = document.createElement("meta");
      m.name = "theme-color";
      document.head.appendChild(m);
      return m;
    })();
  meta.content = resolvedTheme() === "dark" ? BAR_DARK : BAR_LIGHT;
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "auto") delete root.dataset.theme;
  else root.dataset.theme = pref;
  syncMeta();
}

export function setTheme(pref: ThemePref): void {
  snapshot = pref;
  try {
    if (pref === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch { /* private mode */ }
  applyTheme(pref);
  // Auto follows the OS at runtime too, so the status bar changes with it.
  if (typeof window !== "undefined") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (read() === "auto") syncMeta(); });
  }
  listeners.forEach((l) => l());
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(subscribe, read, () => "auto");
}
