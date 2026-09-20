"use client";
import { useEffect, useState } from "react";

/**
 * A stable clock for anything derived from "now" — the wall's ages, the
 * month a usage figure belongs to.
 *
 * Reading `Date.now()` during render is impure: the same state would produce a
 * different tree on an unrelated re-render. The clock is read in the state
 * initialiser instead, which runs once per mount, and again on a tick — so a
 * value that has to age does, and everything else stays the same between
 * renders. With `everyMs` 0 it never ticks.
 *
 * Only the phone and desktop shells use it, and both mount after the browser
 * has answered which shell to render, so there is no server render to disagree
 * with.
 */
export function useNow(everyMs = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!everyMs) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
