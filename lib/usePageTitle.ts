"use client";

import { useEffect } from "react";

/** "Generate · Particl" in the tab — the brand on the one surface the app
 *  doesn't draw. Client pages can't export metadata, so it's set on mount. */
export function usePageTitle(title: string | null) {
  useEffect(() => {
    /* null: the host page owns the title (a suite embedded in /workspace). */
    if (title === null) return;
    const prev = document.title;
    document.title = `${title} · Particl`;
    return () => { document.title = prev; };
  }, [title]);
}
