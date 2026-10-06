"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThinkingModel } from "@/components/atomik/ModelPicker";
import type { AtomikJob } from "@/lib/workbench/atomik-server";
import { saveMessage } from "@/lib/workbench/save-then-continue";

type AgentState = { configured: boolean; models: ThinkingModel[]; jobs: AtomikJob[] };

/**
 * The project's agent runs on the existing Atomik route (`/api/workbench/atomik`,
 * GET: free), for the Hooks writer and the Reference review: which thinking
 * models are priced here, and every run with its plan. Read on open, every few
 * seconds while a run is working, and on request; never in a loop after a
 * failure. Starting a run is the Atomik dialog's alone — it shows the estimate
 * first and keeps a recovery record, so a paid request is never sent twice.
 */
export function useOwnAgent(scope: string, projectId: string, active: boolean) {
  const key = JSON.stringify([scope, projectId, active]);
  const [state, setState] = useState<{ key: string; data?: AgentState; error?: string } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!active || !scope) return;
    const own = ++sequence.current;
    try {
      const response = await fetch(`/api/workbench/atomik?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
      const value = await response.json().catch(() => null) as Partial<AgentState> & { error?: string } | null;
      if (!response.ok) throw new Error(saveMessage(value?.error || "The agent’s runs could not be read."));
      const data: AgentState = { configured: Boolean(value?.configured), models: Array.isArray(value?.models) ? value!.models! : [], jobs: Array.isArray(value?.jobs) ? value!.jobs! : [] };
      if (sequence.current === own) setState({ key, data });
    } catch (error) {
      if (sequence.current === own) setState((old) => ({ key, data: old?.key === key ? old.data : undefined, error: error instanceof Error ? error.message : "The agent’s runs could not be read." }));
    }
  }, [active, scope, projectId, key]);
  const data = state?.key === key ? state.data : undefined;
  const working = Boolean(data?.jobs.some((job) => job.status === "queued" || job.status === "running"));
  useEffect(() => {
    const reads = sequence;
    const first = setTimeout(() => void refresh(), 0);
    const timer = working ? setInterval(() => void refresh(), 4000) : null;
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
      // A read already on its way is dropped when it lands.
      reads.current++;
    };
  }, [refresh, working]);
  return { data, error: state?.key === key ? state.error : undefined, working, refresh };
}
