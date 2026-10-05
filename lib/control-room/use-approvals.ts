"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { APPROVALS_CHANGED, approvalsChanged, approveBatch, approveItem, declineItem, type BatchResult, type PressOutcome } from "./approve";
import type { ApprovalsReply, DecidedItem, QueueItem } from "./queue";

/**
 * The approvals queue in the browser: GET /api/control-room/approvals, read on
 * arrival, again on a pace (often while something waits, rarely otherwise),
 * when the window comes back, and after any press anywhere on the page
 * (APPROVALS_CHANGED). The one queue model: Approvals, Home's "Waiting for
 * you", ⌘K and the phone's "Needs you" all read it through this hook.
 *
 * Presses go through each item's own route (lib/control-room/approve.ts); a
 * plan's step is pressed through its own Continue instead (ThreadCheckpoint).
 */

/** The pace of reads: while something waits, and while nothing does. */
export const APPROVALS_ACTIVE_POLL_MS = 15_000;
export const APPROVALS_IDLE_POLL_MS = 60_000;
export const APPROVALS_READ_FAILED = "Approvals could not be read.";

export type ApprovalsState = {
  status: "loading" | "ready" | "error";
  items: QueueItem[];
  decided: DecidedItem[];
  /** The workspace pays in credits (else no figure is shown). */
  inCredits: boolean;
  /** A read failure, said once; the last good list stays on screen. */
  error: string | null;
  refresh: () => Promise<void>;
  approve: (item: QueueItem) => Promise<PressOutcome>;
  decline: (item: QueueItem) => Promise<PressOutcome>;
  approveBatch: (items: readonly QueueItem[], onStep?: (done: QueueItem, at: number) => void) => Promise<BatchResult>;
};

export function useApprovals(options: { enabled?: boolean } = {}): ApprovalsState {
  const enabled = options.enabled ?? true;
  const session = useSession();
  const scope = session.requestScope ?? null;
  const fetcher = useScopedFetch(scope);
  const [load, setLoad] = useState<{ scope: string | null; status: ApprovalsState["status"]; reply: ApprovalsReply | null; error: string | null }>({ scope, status: "loading", reply: null, error: null });
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !scope) return;
    const mine = ++sequence.current;
    try {
      const response = await fetcher("/api/control-room/approvals", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (ApprovalsReply & { error?: string }) | null;
      if (!response.ok || !body || !Array.isArray(body.items)) throw new Error(body?.error || APPROVALS_READ_FAILED);
      if (mine === sequence.current) setLoad({ scope, status: "ready", reply: body, error: null });
    } catch (error) {
      if (mine !== sequence.current) return;
      const message = error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : APPROVALS_READ_FAILED;
      /* The last list stays: a failed read says so, and the next read tries again on its own. */
      setLoad((previous) => ({ scope, status: previous.scope === scope && previous.reply ? "ready" : "error", reply: previous.scope === scope ? previous.reply : null, error: message }));
    }
  }, [enabled, scope, fetcher]);

  const waiting = load.scope === scope ? (load.reply?.items.length ?? 0) : 0;
  useEffect(() => {
    if (!enabled || !scope) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, waiting ? APPROVALS_ACTIVE_POLL_MS : APPROVALS_IDLE_POLL_MS);
    const again = () => void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener(APPROVALS_CHANGED, again);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(first); clearInterval(timer);
      window.removeEventListener(APPROVALS_CHANGED, again);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, scope, refresh, waiting]);

  const settle = useCallback(async <T,>(work: Promise<T>): Promise<T> => {
    try { return await work; } finally { approvalsChanged(); }
  }, []);

  return useMemo<ApprovalsState>(() => {
    const current = load.scope === scope ? load : { status: "loading" as const, reply: null, error: null };
    return {
      status: current.status,
      items: current.reply?.items ?? [],
      decided: current.reply?.decided ?? [],
      inCredits: current.reply?.inCredits ?? true,
      error: current.error,
      refresh,
      approve: (item) => settle(approveItem(item, fetcher)),
      decline: (item) => settle(declineItem(item, fetcher)),
      approveBatch: (items, onStep) => settle(approveBatch(items, fetcher, onStep)),
    };
  }, [load, scope, refresh, settle, fetcher]);
}
