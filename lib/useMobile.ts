"use client";

import { useEffect, useState } from "react";

/**
 * The phone layout applies below 1024px wide, or on anything under 520px
 * tall (a phone on its side): the composer rail becomes a docked bar and a
 * sheet, the wall becomes filmstrips, the nav a tab bar. The two-pane
 * desktop layout needs both the width and the height. Must match the media
 * query in app/globals.css. False on the server and on first paint, so
 * nothing hydrates against a guess.
 */
export const MOBILE_QUERY = "(max-width: 1023px), (max-height: 520px)";

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return mobile;
}

/** Lock the document's scroll while a sheet is open. */
export function useSheetLock(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
}
