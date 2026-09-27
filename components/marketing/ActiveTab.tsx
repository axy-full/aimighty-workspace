"use client";

import { useEffect } from "react";

/**
 * On a phone the tabs scroll sideways, and the current one can start off
 * screen (Workspace, Pricing). Bring it into view once, sideways only.
 */
export default function ActiveTab() {
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>(".mk-nav");
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const left = tab.offsetLeft - nav.offsetLeft;
    if (left >= nav.scrollLeft && left + tab.offsetWidth <= nav.scrollLeft + nav.clientWidth) return;
    nav.scrollLeft = Math.max(0, left - (nav.clientWidth - tab.offsetWidth) / 2);
  }, []);
  return null;
}
