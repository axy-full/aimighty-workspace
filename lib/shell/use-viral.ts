"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsumerGenjutsuInput } from "@/lib/higgsfield-consumer/genjutsu-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ESTIMATE_LIFETIME_MS, listedJobs, pendingJobIds } from "./viral";

/**
 * The Genjutsu pages' one line to the connected account
 * (`/api/higgsfield/consumer/genjutsu`, the existing route): the connection
 * and capabilities, this project's jobs, a read-only quote for exactly the
 * current input (the *live estimate* the primary requires), submit at that
 * exact price, and polling. Nothing here invents a price.
 */
export type GenjutsuJob = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerGenjutsuInput; workspaceName: string; workspaceId: string; quoteCredits: number; creditUnit: string; quoteExpiresAt: number; quoteExpired?: boolean;
  providerJobId: string | null; result?: { original?: { generationId?: string; asset?: { id?: string; url?: string; kind?: string } } } | null;
  originalAvailability?: string; originalAvailable?: boolean; createdAt: number;
};
export type ViralCapabilities = { resolutions: string[]; minSeconds: number; maxSeconds: number; maxImages: number; maxMediaBytes: number };
export type Estimate = { key: string; credits: number | null; expiresAt: number; error: string | null; job: GenjutsuJob | null };
const ENDPOINT = "/api/higgsfield/consumer/genjutsu";
const POLL_MS = 4000;

export function useViral(draftId: string | null, ready: boolean) {
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ connected: boolean; owner: boolean } | null>(null);
  const [capabilities, setCapabilities] = useState<ViralCapabilities | null>(null);
  const [jobs, setJobs] = useState<GenjutsuJob[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [run, setRun] = useState<{ phase: "idle" } | { phase: "submitting"; job: GenjutsuJob } | { phase: "running"; job: GenjutsuJob } | { phase: "done"; job: GenjutsuJob } | { phase: "failed"; job: GenjutsuJob | null; error: string }>({ phase: "idle" });
  const [listError, setListError] = useState<string | null>(null);

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: GenjutsuJob; error?: string } | null;
    if (!response.ok || !json?.job) throw new Error(json?.error ?? "The connected account could not complete this request.");
    return json.job;
  }, [scoped]);

  const refresh = useCallback(async () => {
    if (!draftId) return;
    try {
      const me = await scoped("/api/me", { cache: "no-store" }).then((r) => r.json()) as { owner?: boolean };
      if (me.owner !== true) { setConnection({ connected: false, owner: false }); return; }
      const response = await scoped(`${ENDPOINT}?draftId=${encodeURIComponent(draftId)}&results=submitted`, { cache: "no-store" });
      const json = await response.json().catch(() => null) as { connection?: { connected?: boolean; requiresReconnect?: boolean }; capabilities?: ViralCapabilities; jobs?: GenjutsuJob[]; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The connected account could not be read.");
      setConnection({ connected: json?.connection?.connected === true && json?.connection?.requiresReconnect !== true, owner: true });
      if (json?.capabilities) setCapabilities(json.capabilities);
      /* What ran, never the estimates the composer read on the way. */
      setJobs(listedJobs(json?.jobs ?? []));
      setListError(null);
    } catch (error) { setListError(error instanceof Error ? error.message : "The connected account could not be read."); }
  }, [scoped, draftId]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [ready, refresh]);

  /** A read-only quote for exactly this input; the key names the input it prices. */
  const quote = useCallback(async (input: ConsumerGenjutsuInput, key: string) => {
    if (!draftId) return;
    try {
      const job = await call({ action: "quote", draftId, input, idempotencyKey: crypto.randomUUID() });
      setEstimate({ key, credits: job.quoteCredits, expiresAt: Math.min(job.quoteExpiresAt, Date.now() + ESTIMATE_LIFETIME_MS), error: null, job });
    } catch (error) {
      setEstimate({ key, credits: null, expiresAt: Date.now() + 30_000, error: error instanceof Error ? error.message : "The estimate could not be read.", job: null });
    }
  }, [call, draftId]);

  const live = useRef(estimate);
  useEffect(() => { live.current = estimate; });
  /** Submit exactly the estimated job at exactly its price. */
  const submit = useCallback(async () => {
    const current = live.current;
    if (!draftId || !current?.job || current.credits == null) return;
    setRun({ phase: "submitting", job: current.job });
    try {
      const job = await call({ action: "submit", draftId, id: current.job.id, workspaceId: current.job.workspaceId, credits: current.credits });
      setEstimate(null);
      setRun(job.status === "completed" ? { phase: "done", job } : job.status === "failed" ? { phase: "failed", job, error: "The connected account reported this job as failed. Failed renders are not billed." } : { phase: "running", job });
      void refresh();
    } catch (error) {
      setRun({ phase: "failed", job: current.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
    }
  }, [call, draftId, refresh]);

  /* Every job the account still holds is polled until it settles — the one submitted here and any
     listed (another page, a reload, another tab) — one status read per tick, so a paid job is never stranded. */
  const pending = pendingJobIds(jobs, run.phase === "running" ? run.job.id : null).join(",");
  const turn = useRef(0);
  useEffect(() => {
    if (!pending || !draftId) return;
    const ids = pending.split(",");
    let stop = false;
    const timer = setInterval(async () => {
      const id = ids[turn.current++ % ids.length];
      try {
        const job = await call({ action: "status", draftId, id });
        if (stop) return;
        setJobs((list) => list.map((j) => (j.id === job.id ? job : j)));
        setRun((current) => {
          if (current.phase !== "running" || current.job.id !== job.id) return current;
          if (job.status === "completed") return { phase: "done", job };
          if (job.status === "failed") return { phase: "failed", job, error: "The connected account reported this job as failed. Failed renders are not billed." };
          return { phase: "running", job };
        });
        if (job.status === "completed") void refresh();
      } catch { /* retried on its next turn */ }
    }, POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [pending, call, draftId, refresh]);

  return { connection, capabilities, jobs, estimate, run, listError, quote, submit, refresh, reset: () => setRun({ phase: "idle" }) };
}
