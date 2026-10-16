"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { cancelWords } from "@/lib/shell/use-key-take";
import { exact, priceSum, priceWords, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { dispatchGeneration, quoteDispatch, type QuotedDispatch } from "@/lib/workspace/generate-submit";
import { dispatchGate, neutralCopy } from "@/lib/workspace/rig";
import { cancellable, type BarState } from "./director-model";

/**
 * "Render 8 shots · 344 cr" (v25 PR 7): the bar's one spend button, through the one workspace-credit path every composer uses
 * (lib/workspace/generate-submit.ts), the way "Show me looks" sends its stills (components/graphite/board/cards/looks/use-looks.ts):
 *
 *  - the price is the SUM of the server's quotes (POST /api/generate/quote) for exactly the requests that will be sent, read free;
 *  - a press prices every shot again before any is sent; if one moved, none is sent, the new figures are shown, and the person presses again;
 *  - then each is sent once, in order, with its own quote as its ceiling (`maxCredits` + the quote's fingerprint) under its own recovery key,
 *    so a lost reply is asked about and never sent twice; the first refusal stops the rest;
 *  - the takes are then read until they settle: "Making…", then "Next: …"; a take still queued at the provider can be cancelled.
 *
 * No new money behaviour: nothing here prices, reserves or settles by itself, and only a person presses it.
 */
export type DirectorShot = { id: string; input: GenerationBodyInput };
type Job = { shotId: string; jobId: string };
type Settled = Record<string, string>;
const ACTIVE = new Set(["queued", "running", "held"]);

export type DirectorRender = {
  state: BarState;
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "error";
  tryAgain: () => void;
  /** Sent so far, of the shots in this press. */
  sent: number;
  /** Takes this press made that have finished (done, failed or cancelled). */
  finished: number;
  total: number;
  problem: string | null;
  canCancel: boolean;
  press: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Back to idle, for the next press (after Next, or a failed run). */
  reset: () => void;
};

export function useDirectorRender({ scope, projectKey, shots, readOnly }: { scope: string; projectKey: string; shots: readonly DirectorShot[]; readOnly?: string | null }): DirectorRender {
  const requests = useMemo(() => Object.fromEntries(shots.map((s) => [s.id, { body: generationRequestBody(s.input) }])), [shots]);
  const pricing = useStageQuotes(scope, requests);
  const ids = Object.keys(requests);
  const credits = ids.map((id) => pricing.quotes[id]?.credits);
  const price = ids.length && credits.every((c) => c != null) ? priceSum(ids.map((id) => exact(pricing.quotes[id]?.credits, pricing.quotes[id]?.usd))) : null;
  const failed = ids.filter((id) => pricing.quotes[id]?.error);
  /* The last price read stays on the button, disabled, while the next is read: never nothing. */
  const [last, setLast] = useState<PriceValue | null>(null);
  if (price && priceWords(price) !== priceWords(last)) setLast(price);
  const reading = Boolean(ids.length) && !price && !failed.length;

  const [state, setState] = useState<BarState>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settled, setSettled] = useState<Settled>({});
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(0);
  const sending = useRef(false);

  const press = useCallback(async () => {
    if (sending.current || readOnly || state !== "idle") return;
    const shown = Object.fromEntries(ids.map((id) => [id, pricing.quotes[id]?.credits ?? null]));
    if (!ids.length || Object.values(shown).some((c) => c == null)) return;
    sending.current = true;
    setState("sending");
    setProblem(null);
    setSent(0);
    const made: Job[] = [];
    try {
      /* Every shot priced as it will be sent, before any is sent: one that moved stops them all. */
      const fresh: Record<string, QuotedDispatch> = {};
      for (const shot of shots) fresh[shot.id] = await quoteDispatch(scope, { endpoint: "/api/generate", input: shot.input });
      if (shots.some((s) => fresh[s.id].credits !== shown[s.id])) {
        for (const s of shots) pricing.reprice(s.id, fresh[s.id].credits);
        const total = (by: (id: string) => number) => shots.reduce((sum, s) => sum + by(s.id), 0);
        const gate = dispatchGate(total((id) => shown[id]!), total((id) => fresh[id].credits));
        setProblem(gate.ok ? null : gate.reason);
        setState("idle");
        return;
      }
      for (const shot of shots) {
        const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, projectKey, `director-${shot.id}`), shown: shown[shot.id]!, request: { endpoint: "/api/generate", input: shot.input }, quoted: fresh[shot.id] });
        if (outcome.state === "repriced") { pricing.reprice(shot.id, outcome.credits); setProblem(outcome.reason); break; }
        if (outcome.state === "refused") { setProblem(outcome.reason); break; }
        made.push({ shotId: shot.id, jobId: outcome.jobId });
        setSent(made.length);
      }
      setJobs(made);
      setSettled({});
      setStatuses({});
      setState(made.length ? "making" : "idle");
    } catch (error) {
      setProblem(neutralCopy(error instanceof Error ? error.message : "", "The shots could not be sent. Nothing more was sent."));
      setJobs(made);
      setState(made.length ? "making" : "idle");
    } finally { sending.current = false; }
  }, [readOnly, state, ids, pricing, shots, scope, projectKey]);

  /* The takes this press made, read until each settles. */
  const watching = state === "making" ? jobs.map((j) => j.jobId).join(",") : "";
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    let alive = true;
    const tick = async () => {
      for (const id of watching.split(",")) {
        if (!alive) return;
        try {
          const { generation } = await studioRequest<{ generation: { id: string; status: string } }>(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
          if (!alive) return;
          setStatuses((now) => (now[id] === generation.status ? now : { ...now, [id]: generation.status }));
          if (!ACTIVE.has(generation.status)) setSettled((now) => (now[id] ? now : { ...now, [id]: generation.status }));
        } catch { /* the next pass reads it again */ }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(timer); controller.abort(); };
  }, [watching, scope]);
  const finished = jobs.filter((j) => settled[j.jobId]).length;
  useEffect(() => { if (state === "making" && jobs.length && finished === jobs.length) setState("done"); }, [state, jobs.length, finished]);

  const cancel = useCallback(async () => {
    const queued = jobs.filter((j) => statuses[j.jobId] === "queued" && !settled[j.jobId]);
    if (!queued.length) return;
    let last = "";
    for (const j of queued) {
      try {
        const result = await studioRequest<{ status?: string }>(`/api/generations/${encodeURIComponent(j.jobId)}/cancel`, { method: "POST", headers: { "X-Workbench-Scope": scope } });
        last = cancelWords(result.status);
      } catch (error) { last = neutralCopy(error instanceof Error ? error.message : "", "The cancel could not be confirmed. Try again."); }
    }
    setProblem(last || null);
  }, [jobs, statuses, settled, scope]);

  const total = jobs.length;
  return {
    state, price: price ?? (reading ? last : null),
    pricing: !ids.length ? "none" : price ? "ready" : failed.length ? "error" : "loading",
    tryAgain: () => { for (const id of failed) pricing.tryAgain(id); },
    sent, finished, total, problem,
    canCancel: state === "making" && cancellable(Object.entries(statuses).filter(([id]) => !settled[id]).map(([, s]) => s)),
    press, cancel,
    reset: () => { setState("idle"); setJobs([]); setSettled({}); setStatuses({}); setProblem(null); setSent(0); },
  };
}
