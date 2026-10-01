"use client";
import { useEffect, useState } from "react";

/** The time, re-read every `ms` (0 = still); ages on a page's rows move without a re-fetch. */
export function useClock(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms <= 0) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0), timer = setInterval(tick, ms);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [ms]);
  return now;
}
