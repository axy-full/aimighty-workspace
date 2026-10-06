"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../useApi";
import { useSession } from "../session";
import { useScopedFetch } from "../useScopedFetch";
import type { SampleBoard } from "./board";
import { sampleGate, type SampleGate, type SampleSubject, SAMPLE_LINE } from "./sample";

/*
 * The browser's half of the sample production. One read of GET /api/demo/sample per mount (the mark and the board's
 * data), and the two answers the screens ask: "is this the sample?" (`useSampleGate`, which streams 4 and 5 read as
 * `ctx.exploreOnly` / `ctx.readOnly`) and "is there a sample to open?" (`useSampleProduction`, Home's card).
 */

/** The sample board for this workspace; null while it loads, when there is none, or when the read failed (nothing is then marked sample on a guess). */
export function useSampleBoard(): { board: SampleBoard | null; loading: boolean } {
  const { requestScope } = useSession();
  const { data, loading } = useApi<{ board: SampleBoard | null }>("/api/demo/sample", 0, requestScope ?? null);
  return { board: data?.board ?? null, loading };
}

/** `{ exploreOnly, readOnly }` for a project: the line a paid control carries when it is the sample, else null. */
export function useSampleGate(project: SampleSubject | null | undefined): SampleGate {
  const { board } = useSampleBoard();
  const id = project?.id ?? null, production = project?.productionProjectId ?? null;
  return useMemo(() => sampleGate({ id, productionProjectId: production }, board?.sample ?? null), [board, id, production]);
}

/*
 * Is this the sample workspace (the owner's switch, 6 Oct)? The server refuses every paid job there
 * (lib/demo/spend-guard.server.ts); the screens then offer no paid control: Enhance, Atomik's ask and Start are not
 * offered or are disabled with the sample's line, with no price. One read of GET /api/demo/sample per workspace scope,
 * shared by every screen that asks, kept for a short while.
 */
const SHARED_MS = 15_000;
const shared = new Map<string, { at: number; answer: Promise<boolean> }>();
function readSampleWorkspace(scope: string | null): Promise<boolean> {
  const key = scope ?? "";
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHARED_MS) return hit.answer;
  const answer = fetch("/api/demo/sample", { cache: "no-store", ...(scope != null ? { headers: { "X-Workbench-Scope": scope } } : {}) })
    .then(async (res) => (res.ok ? Boolean(((await res.json()) as { sampleWorkspace?: unknown }).sampleWorkspace) : false))
    .catch(() => false);
  shared.set(key, { at: Date.now(), answer });
  return answer;
}

/** The sample's line when this workspace is the sample workspace (nothing here spends), else null. Null while it loads. */
export function useSampleWorkspace(): string | null {
  const { requestScope, signedIn } = useSession();
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!signedIn) { setOff(false); return; }
    let live = true;
    void readSampleWorkspace(requestScope ?? null).then((on) => { if (live) setOff(on); });
    return () => { live = false; };
  }, [requestScope, signedIn]);
  return off ? SAMPLE_LINE : null;
}

export type OpenedSample = { draftId: string } | { error: string };

/** Home's SAMPLE card: whether this workspace has a sample, its name, and `open()` for the person's own copy. */
export function useSampleProduction(): { available: boolean; name: string; line: string; open: () => Promise<OpenedSample> } {
  const { board } = useSampleBoard();
  const scoped = useScopedFetch();
  const open = useCallback(async (): Promise<OpenedSample> => {
    try {
      const res = await scoped("/api/demo/sample", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open" }) });
      const json = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) return { error: typeof json.error === "string" ? json.error : "The sample could not be opened. Try again." };
      return { draftId: String(json.project.id) };
    } catch {
      return { error: "The sample could not be opened. Try again." };
    }
  }, [scoped]);
  return { available: Boolean(board), name: board?.sample.name ?? "", line: SAMPLE_LINE, open };
}
