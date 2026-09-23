"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { clearDevelopment, developmentInput, readDevelopment, recordDevelopment, withDevelopmentLock, type PendingDevelopment } from "@/lib/workbench/development-client";
import type { DevelopmentJob, DevelopmentQuote, DevelopmentRequest, DevelopmentState } from "@/lib/workbench/development-types";

const ENDPOINT = "/api/workbench/development";
export type AgentRequest = Omit<DevelopmentRequest, "projectId" | "requestId" | "sourceHash" | "maxCredits" | "maxUsd">;
export type AgentQuote = { value: DevelopmentQuote; input: DevelopmentRequest };

/**
 * The Production agent's runs over the existing development workflow
 * (`/api/workbench/development`): the same quote → reserved start → durable
 * phases → settlement, and the same crash-safe recovery record, as the Studio's
 * development panel. Nothing starts without a quote the director has seen;
 * an unconfirmed start is recovered, never re-sent as a second paid request.
 */
export function useAgentRuns({ scope, projectId, save }: { scope: string; projectId: string; save: () => Promise<boolean> }) {
  const [state, setState] = useState<DevelopmentState | null>(null);
  const [pending, setPending] = useState<PendingDevelopment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<AgentQuote | null>(null);
  const active = useRef(true), pollBusy = useRef(false), epoch = useRef(0);
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);
  const headers = useCallback(() => ({ "Content-Type": "application/json", "X-Workbench-Scope": scope }), [scope]);

  const refresh = useCallback(async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    try {
      const at = epoch.current;
      let record: PendingDevelopment | null = null, storageFailure = "";
      try { record = readDevelopment(window.localStorage, scope, projectId); }
      catch (cause) { storageFailure = cause instanceof Error ? cause.message : "Recovery storage is unavailable."; }
      const query = new URLSearchParams({ projectId });
      if (record) query.set("requestId", developmentInput(record).requestId);
      const next = await studioRequest<DevelopmentState>(`${ENDPOINT}?${query}`, { headers: { "X-Workbench-Scope": scope } });
      if (!active.current || at !== epoch.current) return;
      setState(next); setLoaded(!storageFailure); setPending(record);
      if (storageFailure) setError(`${storageFailure} Saved runs are shown; new paid requests stay paused.`);
      const accepted = record && next.jobs.find((job) => job.requestId === developmentInput(record!).requestId);
      if (record && accepted) { clearDevelopment(window.localStorage, record, accepted.requestId); setPending(null); }
      const queued = next.jobs.find((job) => job.status === "queued");
      if (queued) await studioRequest(ENDPOINT, { method: "POST", headers: headers(), body: JSON.stringify({ resume: true, projectId, jobId: queued.id }) });
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : "The agent's runs could not be loaded.");
    } finally { pollBusy.current = false; }
  }, [headers, projectId, scope]);

  const running = Boolean(state?.jobs.some((job) => job.status === "queued" || job.status === "running"));
  useEffect(() => {
    active.current = true;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), running ? 3000 : 15000);
    return () => { active.current = false; clearTimeout(first); clearInterval(timer); };
  }, [refresh, running]);

  /** Saves the draft, then asks the server for the price of exactly this request. */
  const estimate = useCallback(async (request: AgentRequest) => {
    setBusy("Estimating…"); setError(""); setQuote(null);
    try {
      if (!(await saveRef.current())) throw new Error("Save the project before asking the agent for an estimate.");
      const input: DevelopmentRequest = { ...request, projectId, requestId: crypto.randomUUID() };
      const value = await studioRequest<DevelopmentQuote>(ENDPOINT, { method: "POST", headers: headers(), body: JSON.stringify({ ...input, quoteOnly: true }) });
      if (active.current) setQuote({ value, input });
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "The estimate could not be loaded."); }
    finally { if (active.current) setBusy(""); }
  }, [headers, projectId]);

  const lookup = useCallback((record: PendingDevelopment) => {
    const query = new URLSearchParams({ projectId, requestId: developmentInput(record).requestId });
    return studioRequest<DevelopmentState>(`${ENDPOINT}?${query}`, { headers: { "X-Workbench-Scope": scope } });
  }, [projectId, scope]);
  const accept = useCallback((record: PendingDevelopment, job: DevelopmentJob) => {
    if (job.requestId !== developmentInput(record).requestId) throw new Error("The server returned another request. The original recovery record is kept.");
    clearDevelopment(window.localStorage, record, job.requestId);
    if (!active.current) return;
    setPending(null); setQuote(null);
    setState((old) => ({ configured: old?.configured ?? true, models: old?.models ?? [], jobs: [job, ...(old?.jobs ?? []).filter((value) => value.id !== job.id)] }));
    if (job.error) setError(job.error);
  }, []);

  /** Starts the quoted request, or recovers the unconfirmed one — never both, never twice. */
  const start = useCallback(async () => {
    if (!loaded || (!pending && !quote)) return;
    epoch.current++;
    setBusy(pending ? "Recovering…" : "Starting…"); setError("");
    try {
      await withDevelopmentLock(scope, projectId, async () => {
        const record = pending ?? recordDevelopment(window.localStorage, scope, projectId, JSON.stringify({ ...quote!.input, sourceHash: quote!.value.sourceHash, maxCredits: quote!.value.estimateCredits, ...(quote!.value.estimateUsd == null ? {} : { maxUsd: quote!.value.estimateUsd }) }));
        if (active.current) setPending(record);
        if (pending) {
          const known = (await lookup(record)).jobs.find((job) => job.requestId === developmentInput(record).requestId);
          if (known) { accept(record, known); return; }
        }
        try {
          const next = await studioRequest<{ job: DevelopmentJob }>(ENDPOINT, { method: "POST", headers: headers(), body: record.body });
          accept(record, next.job);
        } catch (cause) {
          let absent = false;
          try {
            const known = (await lookup(record)).jobs.find((job) => job.requestId === developmentInput(record).requestId);
            if (known) { accept(record, known); return; }
            absent = true;
          } catch { /* an ambiguous failure keeps the exact request for recovery */ }
          const status = Number((cause as { status?: number })?.status);
          if (absent && [400, 402, 409, 422].includes(status)) {
            clearDevelopment(window.localStorage, record, developmentInput(record).requestId);
            if (active.current) { setPending(null); setQuote(null); }
          }
          throw cause;
        }
      });
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "The request is unconfirmed. Recover it before starting another."); }
    finally { epoch.current++; if (active.current) setBusy(""); }
  }, [accept, headers, loaded, lookup, pending, projectId, quote, scope]);

  /** One finished run in full (an older writer draft is listed without its script). */
  const load = useCallback(async (jobId: string, offset = 0) => {
    const query = new URLSearchParams({ projectId, jobId, offset: String(offset) });
    return (await studioRequest<{ job: DevelopmentJob }>(`${ENDPOINT}?${query}`, { headers: { "X-Workbench-Scope": scope } })).job;
  }, [projectId, scope]);

  return {
    load,
    configured: state?.configured ?? null, models: state?.models ?? [], jobs: state?.jobs ?? [], loaded, pending, running,
    busy, error, quote, estimate, start, refresh, clearQuote: () => setQuote(null), setError,
    pendingInput: pending ? developmentInput(pending) : null,
  };
}
