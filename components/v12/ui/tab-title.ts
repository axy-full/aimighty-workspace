"use client";
import { useEffect } from "react";

/**
 * The browser tab's title while results wait to be seen (design/particl-prototype-12/README.txt › A): "(N ready)
 * Particl". `tabTitle` is pure (tests/unit/v12-tab-title.spec.ts); `useTabTitle` writes it while mounted and puts the
 * page's own title back when the count returns to 0 or the screen goes.
 */
const READY = /^\(\d+ ready\)\s+/;

export function tabTitle(ready: number, base = "Particl"): string {
  const plain = base.replace(READY, "").trim() || "Particl";
  const n = Number.isFinite(ready) ? Math.max(0, Math.floor(ready)) : 0;
  return n > 0 ? `(${n} ready) ${plain}` : plain;
}

export function useTabTitle(ready: number) {
  useEffect(() => {
    const base = document.title.replace(READY, "");
    document.title = tabTitle(ready, base);
    return () => { document.title = tabTitle(0, document.title); };
  }, [ready]);
}
