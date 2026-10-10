"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Generation } from "@/lib/jobs";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useTrayPrices, renderTakeOf } from "@/components/v12/make/use-results";
import { batchSummary, renderState, type CancelVia, type RenderState, type RenderTake } from "@/lib/v12/renderState";
import { parseTypicalTimes, type TypicalTimesReply } from "@/lib/v12/typicalTimes";
import { cancelFailure, mayCancelTake, discardedOutcome, providerQueueOutcome, type CancelOutcome } from "@/lib/v12/renderCancel";
import { announceJob } from "@/lib/shell/jobs-bus";
import { refreshProjectLibrary } from "@/lib/workspace/library";

/**
 * What a rendering card needs beyond its own row (redesign P3, on C1's model, lib/v12/renderState.ts):
 *  - the engines' typical times (GET /api/v12/typical-times), read once per page;
 *  - the take's place in its line (GET /api/v12/queue-positions), read every few seconds while a take waits;
 *  - the clock, once a second while anything is in flight;
 *  - the figure the ledger holds for it, from the jobs tray (never typed here).
 * Nothing is spent or sent by reading these.
 */

let typicalOnce: Promise<TypicalTimesReply | null> | null = null;

/** Read only when asked for: a screen with nothing in flight, or a customer's app with the switch off, makes no request. */
export function useTypicalTimes(enabled: boolean): TypicalTimesReply | null {
  const fetcher = useScopedFetch();
  const [reply, setReply] = useState<TypicalTimesReply | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    typicalOnce ??= fetcher("/api/v12/typical-times", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body) => (body ? parseTypicalTimes(body) : null)).catch(() => null);
    void typicalOnce.then((r) => { if (live) setReply(r); });
    return () => { live = false; };
  }, [enabled, fetcher]);
  return reply;
}

const POSITION_MS = 10_000;
/* Every waiting card asks; one read answers them all for a few seconds. */
let positionsRead: { at: number; promise: Promise<ReadonlyMap<string, number> | null> } | null = null;
function readPositions(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  if (positionsRead && Date.now() - positionsRead.at < 4_000) return positionsRead.promise;
  const promise = fetcher("/api/v12/queue-positions", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    .then((body: { positions?: Record<string, number> } | null) => (body?.positions ? new Map(Object.entries(body.positions).filter(([, n]) => Number.isFinite(n) && n > 0)) : null))
    .catch(() => null);
  positionsRead = { at: Date.now(), promise };
  return promise;
}

export function useQueuePositions(active: boolean): ReadonlyMap<string, number> {
  const fetcher = useScopedFetch();
  const [positions, setPositions] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => readPositions(fetcher).then((map) => { if (live && map) setPositions(map); });
    void read();
    const timer = setInterval(() => void read(), POSITION_MS);
    return () => { live = false; clearInterval(timer); };
  }, [active, fetcher]);
  return positions;
}

/** The time now, ticking every second while `active`. */
export function useTick(active: boolean, every = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}

/** A take in flight, or a failed one: the states a card says something about. */
export const takeNeedsState = (g: Pick<Generation, "status">) => g.status === "held" || g.status === "queued" || g.status === "running" || g.status === "failed";
const isActive = (g: Pick<Generation, "status">) => g.status === "held" || g.status === "queued" || g.status === "running";

/**
 * The render state of each take given (by generation id), re-read every second while any is in flight. Takes that are
 * settled and fine have no entry beyond "ready".
 */
export function useRenderStates(takes: readonly Generation[]): ReadonlyMap<string, RenderState> {
  const session = useSession();
  const dollars = session.rates.unit === "usd";
  const prices = useTrayPrices();
  /* Nothing is asked of the server for a board with nothing in flight (or none at all: the switch off hands in no takes). */
  const typical = useTypicalTimes(takes.some(takeNeedsState));
  const active = takes.some(isActive);
  const waiting = takes.some((g) => g.status === "held" || g.status === "queued");
  const now = useTick(active);
  const positions = useQueuePositions(waiting);
  return useMemo(() => new Map(takes.map((g) => {
    /* Cancel is offered to the take's author and to an admin: the routes refuse everyone else. */
    const mayCancel = mayCancelTake(session, g.createdBy);
    const base: RenderTake = renderTakeOf(g, prices.get(g.id), dollars, mayCancel);
    return [g.id, renderState({ ...base, queuePosition: positions.get(g.id) ?? null }, now, typical)] as const;
  })), [takes, prices, dollars, positions, now, typical, session]);
}

/**
 * Cancel a take the model says can be cancelled where nothing is billed: a held take is discarded, one waiting in its provider's
 * queue is asked of the provider. The words are what happened (lib/v12/renderCancel.ts): a provider's "requested" is a cancel
 * sent, not a take cancelled, and until the take says otherwise it is shown as pending and not offered again.
 */
export function useCancelTake(scope: string, projectId: string | null, toast: (text: string) => void) {
  const fetcher = useScopedFetch(scope);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const cancel = useCallback(async (id: string, via: CancelVia) => {
    if (busy) return;
    setBusy(id);
    let outcome: CancelOutcome;
    try {
      const response = via === "discard"
        ? await fetcher(`/api/jobs/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ discard: true }) })
        : await fetcher(`/api/generations/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const body = (await response.json().catch(() => null)) as { error?: string; status?: string } | null;
      outcome = !response.ok ? cancelFailure(via, body?.error) : via === "discard" ? discardedOutcome() : providerQueueOutcome(body?.status);
    } catch {
      outcome = cancelFailure(via, null);
    }
    toast(outcome.text);
    if (outcome.pending) setPending((was) => new Set(was).add(id));
    setBusy(null);
    announceJob(id);
    if (projectId) void refreshProjectLibrary(scope, projectId);
  }, [busy, fetcher, projectId, scope, toast]);
  return { cancel, busy, pending };
}

/** A batch's stage meta: "3 of 8 ready · about 4 min left", or null when nothing runs or failed. */
export function batchMeta(items: readonly { name: string; state: RenderState }[]): string | null {
  if (!items.some((i) => i.state.active || i.state.failed)) return null;
  return batchSummary(items);
}
