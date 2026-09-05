"use client";

import { useEffect, useState } from "react";

/**
 * Below 768px the mobile layout applies: the composer rail becomes a docked
 * bar and a sheet, the wall becomes filmstrips, the nav a tab bar. False on
 * the server and on first paint, so nothing hydrates against a guess.
 */
export const MOBILE_QUERY = "(max-width: 767px)";

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
