"use client";

import { useCallback, useMemo } from "react";
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
