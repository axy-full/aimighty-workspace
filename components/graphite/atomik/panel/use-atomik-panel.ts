"use client";
import { useEffect, useState } from "react";
import { ATOMIK_PANEL_EVENT, readAtomik, type AtomikMode, type AtomikPanelDetail } from "@/lib/shell/atomik-panel";
import { howFacts, type HowFacts } from "@/lib/shell/atomik-how";

/**
 * Whether Atomik's panel is open, and how (`&atomik=1`, `&atomik=how`): read from the address on arrival, then from
 * the panel's own events (lib/shell/atomik-panel.ts › openAtomikPanel, closeAtomikPanel, askAtomik) and Back/Forward.
 */
export function useAtomikPanelMode(): AtomikMode | null {
  const [mode, setMode] = useState<AtomikMode | null>(() => (typeof window === "undefined" ? null : readAtomik(window.location.search)));
  useEffect(() => {
    const told = (event: Event) => setMode((event as CustomEvent<AtomikPanelDetail>).detail?.mode ?? null);
    const moved = () => setMode(readAtomik(window.location.search));
    window.addEventListener(ATOMIK_PANEL_EVENT, told);
    window.addEventListener("popstate", moved);
    return () => { window.removeEventListener(ATOMIK_PANEL_EVENT, told); window.removeEventListener("popstate", moved); };
  }, []);
  return mode;
}

/** At this width and up the panel is a 340 px column; below it the phone's Atomik sheet (stream 10) answers. */
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
