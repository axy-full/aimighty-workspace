"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsumerGenjutsuInput } from "@/lib/higgsfield-consumer/genjutsu-contract";
import { resumeProblem } from "@/lib/higgsfield-consumer/resume";
import { poll, pollAfter, turnHint } from "@/lib/poll";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ESTIMATE_LIFETIME_MS, VIRAL_FAILED, listedJobs, pendingJobIds, runAfterStatus, type ViralRun } from "./viral";
import { announceJob } from "./jobs-bus";

/**
 * The Genjutsu pages' one line to the connected account
 * (`/api/higgsfield/consumer/genjutsu`, the existing route): the connection
 * and capabilities, this project's jobs, a read-only quote for exactly the
 * current input (the *live estimate* the primary requires), submit at that
 * exact price, and polling. Nothing here invents a price. A status read
 * that fails for a job still on the account is said plainly on its row
 * (reconnect, storage, an outage) while it keeps being asked after, at
 * lib/poll's pace.
 */
export type GenjutsuJob = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerGenjutsuInput; workspaceName: string; workspaceId: string; quoteCredits: number; creditUnit: string; quoteExpiresAt: number; quoteExpired?: boolean;
  providerJobId: string | null; result?: { original?: { generationId?: string; asset?: { id?: string; url?: string; kind?: string } } } | null;
  originalAvailability?: string; originalAvailable?: boolean; createdAt: number;
  /** The saved reply of a submit whose answer was lost, and whether an unconfirmed job was set aside. */
  providerReceipt?: unknown; setAside?: boolean; failureCode?: string | null;
};
export type ViralCapabilities = { resolutions: string[]; minSeconds: number; maxSeconds: number; maxImages: number; maxMediaBytes: number };
export type Estimate = { key: string; credits: number | null; expiresAt: number; error: string | null; job: GenjutsuJob | null };
const ENDPOINT = "/api/higgsfield/consumer/genjutsu";

export function useViral(draftId: string | null, ready: boolean) {
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ connected: boolean; owner: boolean } | null>(null);
  const [capabilities, setCapabilities] = useState<ViralCapabilities | null>(null);
  const [jobs, setJobs] = useState<GenjutsuJob[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [run, setRun] = useState<ViralRun<GenjutsuJob>>({ phase: "idle" });
  const [listError, setListError] = useState<string | null>(null);
  /** A failed status read for a job still in flight, in the product's words; cleared by its next good read. */
  const [problems, setProblems] = useState<Record<string, string>>({});

  /** One POST on the route: the job, and the account's own pacing when it is a status read. */
  const post = useCallback(async (body: unknown, signal?: AbortSignal) => {
    const response = await scoped(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const json = await response.json().catch(() => null) as { job?: GenjutsuJob; pollAfterSeconds?: number; error?: string; code?: string } | null;
    if (!response.ok || !json?.job) throw Object.assign(new Error(json?.error ?? "The connected account could not complete this request."), { code: json?.code, status: response.status });
    return { job: json.job, pollAfterSeconds: pollAfter(json) };
  }, [scoped]);
  const call = useCallback(async (body: unknown) => (await post(body)).job, [post]);

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
      announceJob(job.id);
      setEstimate(null);
      setRun(job.status === "completed" ? { phase: "done", job } : job.status === "failed" ? { phase: "failed", job, error: VIRAL_FAILED } : { phase: "running", job });
      void refresh();
    } catch (error) {
      setRun({ phase: "failed", job: current.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
      /* A lost reply may still have reached the account: the list says so, and a job it took is polled
         like any other — this run too, which then shows it rendering. */
      void refresh();
    }
  }, [call, draftId, refresh]);

  /* Every job the account still holds is polled until it settles — the one submitted here and any
     listed (another page, a reload, another tab) — one status read at a time, in turn, at lib/poll's
     pace, so a paid job is never stranded. The set changing (a job settles) starts the pace again.
     The account's pace for one job is shared out across the turn, and the job asked next is never
     asked before its own last reply's pollAfterSeconds is up (the account holds that job's lease until
     then), even when the jobs' hints differ or the poll has just started over. */
  const pending = pendingJobIds(jobs, run.phase === "running" ? run.job.id : null).join(",");
  const turn = useRef(0);
  const leaseEnds = useRef(new Map<string, number>());
  useEffect(() => {
    if (!pending || !draftId) return;
    const ids = pending.split(",");
    let asked = ids[0];
    const owed = () => { const at = leaseEnds.current.get(ids[turn.current % ids.length]); return at ? Math.max(0, (at - Date.now()) / 1000) : 0; };
    const poller = poll({
      firstHint: owed() || null,
      read: (signal) => { asked = ids[turn.current++ % ids.length]; return post({ action: "status", draftId, id: asked }, signal); },
      hint: (reply) => Math.max(turnHint(reply.pollAfterSeconds, ids.length) ?? 0, owed()) || null,
      /* The list decides: a settled job leaves `pending`, which starts a poll over the rest. */
      done: () => false,
      onValue: ({ job, pollAfterSeconds }) => {
        if (pollAfterSeconds) leaseEnds.current.set(job.id, Date.now() + pollAfterSeconds * 1000);
        setJobs((list) => list.map((j) => (j.id === job.id ? job : j)));
        setProblems((all) => { if (!(job.id in all)) return all; const next = { ...all }; delete next[job.id]; return next; });
        setRun((current) => runAfterStatus(current, job));
        if (job.status === "completed") void refresh();
      },
      onError: (error) => {
        /* Asked again after a longer wait; meanwhile the row says what is wrong and who can fix it. */
        const id = asked, problem = resumeProblem(error);
        setProblems((all) => (all[id] === problem ? all : { ...all, [id]: problem }));
      },
    });
    return () => poller.stop();
  }, [pending, post, draftId, refresh]);

  return { connection, capabilities, jobs, problems, estimate, run, listError, quote, submit, refresh, reset: () => setRun({ phase: "idle" }) };
}
