"use client";
import { useEffect, useState } from "react";

/**
 * Whether a take is the starter production's sample clip (Big Buck Bunny, CC BY 3.0: lib/sampleClip.ts), so the surface that shows it can carry the credit
 * (components/ui/SampleClipCredit.tsx). Read once from GET /api/sample-clip (the takes of this workspace that hold the clip) and shared by every surface on the page;
 * a take that is not in a read more than a few seconds old asks again, so a starter opened a moment ago is not missed. A failed read is "no credit", never an error.
 */
const FRESH_MS = 4_000;
let read: { at: number; ids: Promise<Set<string>> } | null = null;

function ids(force = false): Promise<Set<string>> {
  if (!read || force) {
    read = {
      at: Date.now(),
      ids: fetch("/api/sample-clip", { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ takes?: unknown }>) : { takes: [] }))
        .then((body) => new Set<string>(Array.isArray(body.takes) ? body.takes.filter((t): t is string => typeof t === "string") : []))
        .catch(() => new Set<string>()),
    };
  }
  return read.ids;
}

/** The generation id behind a Library id (`generation:<id>`), a media URL (`/api/media/<id>`) or a bare id; null for anything else. */
export function takeIdOf(value: string | null | undefined): string | null {
  const text = String(value ?? "");
  const m = /^(?:generation:|\/api\/media\/)?([A-Za-z0-9_-]{1,160})(?:[/?#].*)?$/.exec(text);
  return m && !text.startsWith("upload:") ? m[1] : null;
}

export function useSampleClipTake(value: string | null | undefined): boolean {
  const id = takeIdOf(value);
  /* The id the answer is for: a card that now shows another take is off until that take's own answer comes. */
  const [matched, setMatched] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void ids().then(async (set) => {
      let found = set.has(id);
      if (!found && read && Date.now() - read.at > FRESH_MS) found = (await ids(true)).has(id);
      if (live) setMatched(found ? id : null);
    });
    return () => { live = false; };
  }, [id]);
  return id !== null && matched === id;
}
