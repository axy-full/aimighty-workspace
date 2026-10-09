"use client";
import { useEffect, useState } from "react";
import { howFacts, type HowFacts } from "@/lib/shell/atomik-how";

/** At this width and up the panel is a 340 px column; below it the phone's own Atomik sheet (stream 10) answers. */
export const PANEL_FROM = 768;

export function useWideEnough(): boolean {
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= PANEL_FROM));
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= PANEL_FROM);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

/* The rate card is the same for every answer: read once a page, free (GET /api/plans, credits only). */
let facts: Promise<HowFacts> | null = null;
function readFacts(): Promise<HowFacts> {
  facts ??= fetch("/api/plans", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { rates?: unknown } | null) => howFacts(body?.rates))
    .catch(() => { facts = null; return {}; });
  return facts;
}

/** The figures how-to answers may quote, once the rate card is read; empty until then (answers then name no figure). */
export function useHowFacts(active: boolean): HowFacts {
  const [value, setValue] = useState<HowFacts>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    void readFacts().then((f) => { if (live) setValue(f); });
    return () => { live = false; };
  }, [active]);
  return value;
}
