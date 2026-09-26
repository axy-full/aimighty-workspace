"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsumerGenjutsuInput } from "@/lib/higgsfield-consumer/genjutsu-contract";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { ESTIMATE_LIFETIME_MS, mergeRuns, runCannotSettle, runInFlight } from "./viral";

/**
 * The Genjutsu pages' one line to the connected account
 * (`/api/higgsfield/consumer/genjutsu`, the existing route): the connection
 * and capabilities, this project's runs a page at a time (its `view=runs`:
 * estimates are not runs and never listed; beside a composer, only that
 * page's variant), a read-only quote for exactly the current input (the
 * *live estimate* the primary requires), submit at that exact price, and
 * reading every run still in flight — including ones sent before this page
 * opened — until the account settles it, at the pace the account asks for.
 * A run that cannot move on its own is read a few times, then left for the
 * person to check again. A run that lands re-reads the project's Library
 * once, so Takes and the Library show it without a reload. Nothing here
 * invents a price or sends a job twice.
 */
export type GenjutsuJob = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerGenjutsuInput; workspaceName: string; workspaceId: string; quoteCredits: number; creditUnit: string; quoteExpiresAt: number; quoteExpired?: boolean;
  providerJobId: string | null; providerReceipt?: unknown; result?: { original?: { generationId?: string; asset?: { id?: string; url?: string; kind?: string } } } | null;
  originalAvailability?: string; originalAvailable?: boolean; createdAt: number; updatedAt?: number;
};
export type ViralCapabilities = { resolutions: string[]; minSeconds: number; maxSeconds: number; maxImages: number; maxMediaBytes: number };
export type Estimate = { key: string; credits: number | null; expiresAt: number; error: string | null; job: GenjutsuJob | null };
/** Where this project's run list stands: the first read, then older pages on request. */
export type ViralRuns = { status: "idle" | "loading" | "ready" | "error"; nextCursor: string | null; more: "idle" | "loading" | "error" };
type RunPhase = { phase: "idle" } | { phase: "submitting"; job: GenjutsuJob } | { phase: "running"; job: GenjutsuJob } | { phase: "done"; job: GenjutsuJob } | { phase: "failed"; job: GenjutsuJob | null; error: string };
type Runs = { draftId: string; jobs: GenjutsuJob[]; status: "loading" | "ready" | "error"; error: string | null; nextCursor: string | null; pages: number; more: ViralRuns["more"] };
type ListReply = { connection?: { connected?: boolean; requiresReconnect?: boolean }; capabilities?: ViralCapabilities; jobs?: GenjutsuJob[]; nextCursor?: string | null; error?: string } | null;

const ENDPOINT = "/api/higgsfield/consumer/genjutsu";
/** One read per tick at most, whatever is in flight. */
const POLL_MS = 4000;
/** The longest a run in flight waits between reads, and how many reads a run that cannot move on its own gets. */
const POLL_MAX_MS = 60_000, STALL_READS = 3;
type Watch = { at: number; reads: number; status: string };
/** Why a run is no longer read on its own: nothing can move it, or the route could not find it. */
export type Stall = "unconfirmed" | "gone";
const FAILED = "The connected account reported this job as failed. Failed renders are not billed.";
const UNREADABLE = "The connected account could not be read.";
const phaseFor = (job: GenjutsuJob): RunPhase =>
  job.status === "completed" ? { phase: "done", job } : job.status === "failed" ? { phase: "failed", job, error: FAILED } : { phase: "running", job };

export function useViral(scope: string, draftId: string | null, variant: ConsumerGenjutsuInput["variant"] | null = null) {
  const ready = Boolean(scope);
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ connected: boolean; owner: boolean } | null>(null);
  const [capabilities, setCapabilities] = useState<ViralCapabilities | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [run, setRun] = useState<RunPhase>({ phase: "idle" });
  /* The project the answers belong to: a reply for a project no longer open is dropped. */
  const draft = useRef(draftId);
  const liveRuns = useRef(runs);
  const liveRun = useRef(run);
  useEffect(() => { draft.current = draftId; liveRuns.current = runs; liveRun.current = run; });

  const call = useCallback(async (body: unknown) => {
    const response = await scoped(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as { job?: GenjutsuJob; error?: string } | null;
    if (!response.ok || !json?.job) throw new Error(json?.error ?? "The connected account could not complete this request.");
    return json.job;
  }, [scoped]);

  const readPage = useCallback(async (id: string, cursor: string | null) => {
    const query = new URLSearchParams({ draftId: id, view: "runs" });
    if (variant) query.set("variant", variant);
    if (cursor) query.set("cursor", cursor);
    const response = await scoped(`${ENDPOINT}?${query}`, { cache: "no-store" });
    const json = await response.json().catch(() => null) as ListReply;
    if (!response.ok) throw new Error(json?.error ?? UNREADABLE);
    return json;
  }, [scoped, variant]);

  /** The first page again, over whatever is on hand: runs settle in place and older pages stay loaded. */
  const refresh = useCallback(async () => {
    if (!draftId) return;
    const mine = () => draft.current === draftId;
    setRuns((prev) => (mine() && prev?.draftId === draftId && prev.status === "error" ? { ...prev, status: "loading", error: null } : prev));
    try {
      const me = await scoped("/api/me", { cache: "no-store" }).then((r) => r.json()) as { owner?: boolean };
      if (me.owner !== true) {
        setConnection({ connected: false, owner: false });
        setRuns((prev) => (mine() ? { draftId, jobs: [], status: "ready", error: null, nextCursor: null, pages: 1, more: "idle" } : prev));
        return;
      }
      const json = await readPage(draftId, null);
      setConnection({ connected: json?.connection?.connected === true && json?.connection?.requiresReconnect !== true, owner: true });
      if (json?.capabilities) setCapabilities(json.capabilities);
      setRuns((prev) => {
        if (!mine()) return prev;
        const same = prev?.draftId === draftId ? prev : null, deeper = same && same.pages > 1 ? same : null;
        return {
          draftId, jobs: mergeRuns(json?.jobs ?? [], same?.jobs ?? []), status: "ready", error: null,
          nextCursor: deeper ? deeper.nextCursor : json?.nextCursor ?? null, pages: deeper ? deeper.pages : 1, more: same?.more ?? "idle",
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : UNREADABLE;
      setRuns((prev) => {
        if (!mine()) return prev;
        /* Runs already on screen stay; the failure shows beside them. */
        if (prev?.draftId === draftId && prev.jobs.length) return { ...prev, status: "ready", error: message };
        return { draftId, jobs: [], status: "error", error: message, nextCursor: null, pages: 0, more: "idle" };
      });
    }
  }, [scoped, draftId, readPage]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [ready, refresh]);

  /** The next older page, by the cursor the last page ended on. */
  const loadMore = useCallback(async () => {
    const now = liveRuns.current;
    if (!draftId || !now || now.draftId !== draftId || !now.nextCursor || now.more === "loading") return;
    const cursor = now.nextCursor;
    setRuns((prev) => (prev?.draftId === draftId ? { ...prev, more: "loading" } : prev));
    try {
      const json = await readPage(draftId, cursor);
      /* A refresh that moved the first page's cursor meanwhile makes this page stale: dropped, and the button ready again. */
      setRuns((prev) => (prev?.draftId !== draftId ? prev : prev.nextCursor === cursor
        ? { ...prev, jobs: mergeRuns(json?.jobs ?? [], prev.jobs), nextCursor: json?.nextCursor ?? null, pages: prev.pages + 1, more: "idle" }
        : { ...prev, more: "idle" }));
    } catch {
      setRuns((prev) => (prev?.draftId === draftId ? { ...prev, more: "error" } : prev));
    }
  }, [draftId, readPage]);

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

  /* A run the account answered for: into the list in place, onto the primary if it is the one just sent, and — once it lands — into the Library. */
  const landed = useRef(new Set<string>());
  const land = useCallback((job: GenjutsuJob) => {
    setRuns((prev) => (prev?.draftId === job.draftId ? { ...prev, jobs: mergeRuns([job], prev.jobs) } : prev));
    setRun((prev) => ((prev.phase === "submitting" || prev.phase === "running") && prev.job.id === job.id ? phaseFor(job) : prev));
    if (job.status === "completed" && !landed.current.has(job.id)) {
      landed.current.add(job.id);
      if (scope) void refreshProjectLibrary(scope, job.draftId);
    }
  }, [scope]);

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
      land(job);
    } catch (error) {
      setRun({ phase: "failed", job: current.job, error: error instanceof Error ? error.message : "The job could not be submitted." });
    }
  }, [call, draftId, land]);

  const current = draftId && runs?.draftId === draftId ? runs : null;
  const jobs = current?.jobs ?? [];
  /* Runs no longer read on their own, by the state they stopped in (and why: unconfirmed, or the account's route no longer has it); each shows Check again until it moves. */
  const [stalled, setStalled] = useState<ReadonlyMap<string, { status: string; why: Stall }>>(() => new Map());
  const stalledAs = useCallback((job: { id: string; status: string }): Stall | null => {
    const at = stalled.get(job.id);
    return at && at.status === job.status ? at.why : null;
  }, [stalled]);
  const watch = useRef(new Map<string, Watch>());
  /** When a run is read next: at the account's own pace while it renders, backing off while it is unchanged; a run that cannot move on its own, or that the account no longer has, stops. */
  const schedule = useCallback((id: string, job: GenjutsuJob | null, pollAfterSeconds?: number) => {
    const prev = watch.current.get(id);
    if (job && !runInFlight(job.status)) { watch.current.delete(id); return; }
    const onHand = liveRuns.current?.jobs.find((j) => j.id === id) ?? (liveRun.current.phase !== "idle" && liveRun.current.job?.id === id ? liveRun.current.job : null);
    const status = job?.status ?? onHand?.status ?? prev?.status ?? "";
    const reads = prev && prev.status === status ? prev.reads + 1 : 1;
    if (!job || (runCannotSettle(job) && reads >= STALL_READS)) {
      watch.current.delete(id);
      setStalled((prior) => new Map(prior).set(id, { status, why: job ? "unconfirmed" : "gone" }));
      return;
    }
    const backoff = Math.min(POLL_MS * 2 ** (reads - 1), POLL_MAX_MS);
    const wait = job.status === "accepted" && pollAfterSeconds ? Math.min(pollAfterSeconds * 1000, POLL_MAX_MS) : backoff;
    watch.current.set(id, { at: Date.now() + wait, reads, status });
  }, []);
  const readRun = useCallback(async (id: string) => {
    if (!draftId) return;
    const response = await scoped(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", draftId, id }) });
    const json = await response.json().catch(() => null) as { job?: GenjutsuJob; pollAfterSeconds?: number } | null;
    if (response.status === 404) { schedule(id, null); return; }
    if (!response.ok || !json?.job) {
      /* Unreadable for now (the account, the network, the route's budget): read again later, less often. */
      const prev = watch.current.get(id);
      watch.current.set(id, { at: Date.now() + Math.min(POLL_MS * 2 ** (prev?.reads ?? 0), POLL_MAX_MS), reads: (prev?.reads ?? 0) + 1, status: prev?.status ?? "" });
      return;
    }
    land(json.job);
    schedule(id, json.job, json.pollAfterSeconds);
  }, [draftId, scoped, land, schedule]);
  /*
   * Every run in flight is read until it settles — the one just sent and any
   * the list found still rendering — one per tick at most, in turn, each when
   * it is due, so four at once cost no more requests than one. A hidden tab waits.
   */
  const pollKey = [...new Set([...jobs, ...(run.phase === "running" ? [run.job] : [])].filter((j) => runInFlight(j.status) && !stalledAs(j)).map((j) => j.id))].join(",");
  useEffect(() => {
    if (!draftId || !pollKey) return;
    const ids = pollKey.split(",");
    let turn = 0, busy = false;
    const timer = setInterval(() => {
      if (busy || document.hidden) return;
      const now = Date.now();
      const next = ids.map((_, k) => (turn + k) % ids.length).find((i) => (watch.current.get(ids[i])?.at ?? 0) <= now);
      if (next === undefined) return;
      turn = next + 1;
      busy = true;
      readRun(ids[next]).catch(() => undefined).finally(() => { busy = false; });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [draftId, pollKey, readRun]);
  /** A run left alone is read again, from the start. */
  const recheck = useCallback((id: string) => {
    watch.current.delete(id);
    setStalled((prior) => { const next = new Map(prior); next.delete(id); return next; });
  }, []);

  const list: ViralRuns = { status: !draftId ? "idle" : current?.status ?? "loading", nextCursor: current?.nextCursor ?? null, more: current?.more ?? "idle" };
  return {
    connection, capabilities, jobs, list, listError: current?.error ?? null, estimate, run, stalledAs,
    quote, submit, refresh, loadMore, recheck, reset: () => setRun({ phase: "idle" }),
  };
}
