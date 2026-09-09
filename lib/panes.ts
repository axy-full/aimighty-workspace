"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * How wide each surface's rail is, per person (SOW §10 4.1).
 *
 * "A director and an artist do not want the same split." Neither does the
 * same person on a 27" display and on a laptop, which is why this is kept in
 * the browser rather than on the server. It is the opposite case to Setup:
 * a production's Setup is a decision the team shares and belongs in the
 * database, while a pane split is a personal, screen-shaped preference and
 * belongs to the machine it was chosen on.
 *
 * Not synced between tabs, for the same reason the chosen production is not:
 * a value another window can change under you is a value that moves while
 * you are using it. Storage remembers it between visits; it is not a channel.
 */

export type PaneSpec = {
  /** Storage key and the CSS custom property the surface reads. */
  key: string;
  def: number;
  min: number;
  max: number;
};

export const PANES = {
  composer: { key: "composer", def: 400, min: 320, max: 720 },
  canvas: { key: "canvas", def: 360, min: 300, max: 680 },
  studio: { key: "studio", def: 380, min: 320, max: 680 },
  builder: { key: "builder", def: 400, min: 320, max: 720 },
} satisfies Record<string, PaneSpec>;

const PREFIX = "aw_pane:";
const listeners = new Map<string, Set<() => void>>();
const held = new Map<string, number>();

/**
 * Clamped to the spec AND to the window, so a rail saved on a wide display
 * cannot swallow a narrow one. Half the viewport is the hard ceiling: past
 * that the rail is the work surface and the work surface is the rail.
 */
export function clampWidth(spec: PaneSpec, n: number, viewport?: number): number {
  const room = viewport && viewport > 0 ? Math.max(spec.min, Math.floor(viewport / 2)) : spec.max;
  const ceiling = Math.min(spec.max, room);
  if (!Number.isFinite(n)) return spec.def;
  return Math.round(Math.min(ceiling, Math.max(spec.min, n)));
}

function subscribe(key: string) {
  return (cb: () => void) => {
    const set = listeners.get(key) ?? new Set();
    set.add(cb);
    listeners.set(key, set);
    return () => { set.delete(cb); };
  };
}

function read(spec: PaneSpec): number {
  const hit = held.get(spec.key);
  if (hit !== undefined) return hit;
  let v = spec.def;
  try {
    const raw = localStorage.getItem(PREFIX + spec.key);
    if (raw) v = clampWidth(spec, Number(raw));
  } catch { /* private mode: the default, every time */ }
  held.set(spec.key, v);
  return v;
}

function write(spec: PaneSpec, n: number) {
  const v = clampWidth(spec, n, typeof window === "undefined" ? undefined : window.innerWidth);
  if (held.get(spec.key) === v) return;
  held.set(spec.key, v);
  try { localStorage.setItem(PREFIX + spec.key, String(v)); } catch { /* fine */ }
  listeners.get(spec.key)?.forEach((l) => l());
}

/** The width, and a setter that clamps and remembers. */
export function usePaneWidth(spec: PaneSpec): [number, (n: number) => void] {
  const width = useSyncExternalStore(
    subscribe(spec.key),
    () => read(spec),
    () => spec.def,          // the server has no browser to ask
  );
  const set = useCallback((n: number) => write(spec, n), [spec]);
  return [width, set];
}
