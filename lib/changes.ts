"use client";

import { useEffect, useRef } from "react";

/**
 * A one-line bus for "a render changed under you". The right-click menu
 * renames, moves and deletes from outside any screen's state, and the wall
 * polls only every few seconds — so a rename would otherwise sit stale for
 * a beat. Screens that show renders subscribe and refetch at once.
 */
const EVENT = "aw:gen-changed";

export function announceChange(): void {
  if (typeof document !== "undefined") document.dispatchEvent(new Event(EVENT));
}

export function useOnChange(fn: () => void): void {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    const h = () => ref.current();
    document.addEventListener(EVENT, h);
    return () => document.removeEventListener(EVENT, h);
  }, []);
}
