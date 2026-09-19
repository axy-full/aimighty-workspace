"use client";
import { useEffect, useState } from "react";
import type { RunLite } from "@/lib/workspace/spec-cards";

/* Read-only data the spec cards count from. Both read existing routes the
   Atomik suite already reads (components/suites/AtomikSuite.tsx); nothing
   server-side is added. */

async function scoped<T>(url: string, scope: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { "X-Workbench-Scope": scope }, cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error((body && typeof body.error === "string" && body.error) || `The request failed (${response.status}).`);
  return body as T;
}

type RunRecord = RunLite & { context?: { projectId?: string } };

/** GET /api/pipelines?projectId — this production's runs, refreshed every 30s. `null` until loaded. */
export function usePipelineRuns(productionId: string | null | undefined, scope: string | null): RunLite[] | null {
  const [state, setState] = useState<{ key: string; runs: RunLite[] } | null>(null);
  const key = productionId && scope ? `${scope}:${productionId}` : "";
  useEffect(() => {
    if (!productionId || !scope) return;
    const controller = new AbortController();
    const load = () =>
      scoped<{ runs?: RunRecord[] }>(`/api/pipelines?projectId=${encodeURIComponent(productionId)}`, scope, controller.signal)
        /* Fail closed on another production's runs, as the Atomik suite does. */
        .then((body) => setState({ key: `${scope}:${productionId}`, runs: (body.runs ?? []).filter((run) => run.context?.projectId === productionId) }))
        .catch(() => { /* The cards keep READY; the mounted suite reports load errors. */ });
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [productionId, scope]);
  return state && state.key === key ? state.runs : null;
}

type BudgetProject = { id: string; credits: number; capCredits: number | null };

/** GET /api/projects — the production's settled spend and cap, in credits. */
export function useProjectBudget(productionId: string | null | undefined, scope: string | null) {
  const [state, setState] = useState<{ key: string; budget: { credits: number; capCredits: number | null } } | null>(null);
  const key = productionId && scope ? `${scope}:${productionId}` : "";
  useEffect(() => {
    if (!productionId || !scope) return;
    const controller = new AbortController();
    scoped<{ projects?: BudgetProject[] }>("/api/projects", scope, controller.signal)
      .then((body) => {
        const found = (body.projects ?? []).find((item) => item.id === productionId);
        if (found) setState({ key: `${scope}:${productionId}`, budget: { credits: Number(found.credits) || 0, capCredits: found.capCredits ?? null } });
      })
      .catch(() => { /* Facts show "—" until the budget reads. */ });
    return () => controller.abort();
  }, [productionId, scope]);
  return state && state.key === key ? state.budget : null;
}
