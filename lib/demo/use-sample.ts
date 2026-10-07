"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useApi } from "../useApi";
import { useSession } from "../session";
import { useScopedFetch } from "../useScopedFetch";
import type { SampleBoard } from "./board";
import { CHECK_LINE, sampleGate, type SampleCheck, type SampleGate, type SampleSubject, SAMPLE_LINE } from "./sample";
import { sampleChecker } from "./sample-check";

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
 * offered or are disabled with a line, with no price. One read of GET /api/demo/sample per workspace scope, shared by
 * every screen that asks (lib/demo/sample-check.ts). It says one of three things: "sample", "normal", or "unknown" when
 * the read failed. Unknown fails closed for spending (the same hidden controls) but says CHECK_LINE, not the sample's
 * line, and is read again on its own (2 s, 5 s, 15 s) and by the person's free Try again.
 */
export type SampleWorkspaceCheck = {
  /** null while the first read is out, and for a workspace that is not the sample. */
  state: SampleCheck | null;
  /** Read again now; the automatic waits start over. */
  retry: () => void;
};

export function useSampleCheck(): SampleWorkspaceCheck {
  const { requestScope, signedIn } = useSession();
  const scope = requestScope ?? null;
  const slot = useSyncExternalStore(sampleChecker.subscribe, () => sampleChecker.get(scope), () => sampleChecker.get(null));
  useEffect(() => {
    if (!signedIn) return;
    void sampleChecker.ensure(scope);
  }, [scope, signedIn]);
  const retry = useCallback(() => { void sampleChecker.retry(scope); }, [scope]);
  return { state: signedIn ? slot.state : null, retry };
}

/**
 * Nothing here spends: the sample's line when this is the sample workspace, CHECK_LINE while it could not be checked,
 * else null (and null while it loads). A truthy answer means "offer no priced control".
 */
export function useSampleWorkspace(): string | null {
  const { state } = useSampleCheck();
  return state === "sample" ? SAMPLE_LINE : state === "unknown" ? CHECK_LINE : null;
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
