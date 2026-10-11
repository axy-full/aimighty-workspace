"use client";
import { useEffect, useMemo, useState } from "react";
import type { Generation } from "@/lib/jobs";
import type { TrayJob } from "@/lib/jobsTray";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { RESULTS_READ, resultTiles, type ResultTile } from "@/lib/v12/make";
import { parseTypicalTimes, type TypicalTimesReply } from "@/lib/v12/typicalTimes";
import type { RenderPrice, RenderTake } from "@/lib/v12/renderState";

/**
 * Make's results: the workspace's takes, newest first, from today's takes list (GET /api/jobs, scoped by the request
 * scope), read again when a take starts or ends (the jobs bus) and every few seconds while one is in flight. The money
 * of a take in flight is the jobs tray's (the meter's reserved figure, lib/jobsTray.server); a settled take's is the
 * ledger's (`creditsBilled`). Typical times come from GET /api/v12/typical-times (C1).
 */
export type ResultsState = { status: "loading" | "ready" | "error"; tiles: ResultTile[]; typical: TypicalTimesReply | null };

const ACTIVE = new Set(["held", "queued", "running"]);
const POLL_MS = 8_000;

export function useResults(scope: string): ResultsState & { refresh: () => void } {
  const fetcher = useScopedFetch(scope);
  const [state, setState] = useState<ResultsState>({ status: "loading", tiles: [], typical: null });
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("particl:jobs", bump);
    return () => window.removeEventListener("particl:jobs", bump);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetcher(`/api/jobs?limit=${RESULTS_READ}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { generations?: Generation[] } | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(body?.generations)) { setState((s) => ({ ...s, status: s.tiles.length ? "ready" : "error" })); return; }
        setState((s) => ({ ...s, status: "ready", tiles: resultTiles(body.generations!) }));
      })
      .catch(() => { if (!controller.signal.aborted) setState((s) => ({ ...s, status: s.tiles.length ? "ready" : "error" })); });
    return () => controller.abort();
  }, [fetcher, tick]);
  /* Typical times: once per page. */
  useEffect(() => {
    let live = true;
    fetcher("/api/v12/typical-times", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body) => {
      if (live && body) setState((s) => ({ ...s, typical: parseTypicalTimes(body) }));
    }).catch(() => { /* the config's ranges stand in */ });
    return () => { live = false; };
  }, [fetcher]);
  const active = state.tiles.some((t) => ACTIVE.has(t.source.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  return { ...state, refresh };
}

/** The tray's figure for each take in flight, by id. */
export function useTrayPrices(): ReadonlyMap<string, TrayJob["price"]> {
  const jobs = useJobsTray()?.jobs;
  return useMemo(() => new Map((jobs ?? []).map((j) => [j.id, j.price])), [jobs]);
}

const asPrice = (p: TrayJob["price"] | null | undefined): RenderPrice | null =>
  p && (p.unit === "cr" || p.unit === "usd") && Number.isFinite(p.amount) ? { amount: p.amount, unit: p.unit } : null;

/** A take as the render-state model reads it (lib/v12/renderState.ts), from what the browser may see of it. */
export function renderTakeOf(g: Generation, trayPrice: TrayJob["price"] | null | undefined, paysInDollars: boolean): RenderTake {
  const p = (g.params ?? {}) as Record<string, unknown>;
  const held = p.held && typeof p.held === "object" ? (p.held as RenderTake["held"]) : null;
  const settled = g.status === "succeeded" || g.status === "failed" || g.status === "cancelled";
  const charged: RenderPrice | null = !settled ? null
    : paysInDollars ? (typeof g.costUsd === "number" ? { amount: g.costUsd, unit: "usd" } : null)
      : typeof g.creditsBilled === "number" ? { amount: g.creditsBilled, unit: "cr" } : null;
  return {
    id: g.id, status: g.status, kind: g.kind, model: g.model, provider: g.provider, createdAt: g.createdAt, held,
    /* The browser sees a provider's task id for Ark and fal takes; the rest wait as "Preparing" until they run. */
    atProvider: Boolean(g.arkTaskId || (typeof p.falRequestId === "string" && p.falRequestId)),
    price: asPrice(trayPrice), charged, discarded: g.status === "cancelled" && p.discardedAt != null,
  };
}
