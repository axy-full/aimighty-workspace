"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { draftRequest } from "@/lib/workbench/draft-request";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import { dispatchGeneration, quoteDispatch } from "@/lib/workspace/generate-submit";
import { cutoutClaimKey, cutoutProblem, cutoutRequest, cutoutRunKey, readCutoutRun, type CutoutRun } from "@/lib/workspace/cutout";
import { formatCredits } from "@/lib/workspace/cost";
import { neutralCopy } from "@/lib/workspace/rig";

/*
 * Cut-outs on the Rig, run above the Inspector so one keeps going (and is
 * filed on its card when it finishes) while the person picks another card or
 * another page. A cut-out is a paid render: it is quoted first ("about N cr"),
 * sent only once the person approves that price, and sent through the shared
 * dispatch (lib/workspace/generate-submit), so a lost reply is asked about by
 * its own key and never sent again. While it runs it is remembered in this
 * browser (cutoutRunKey), so leaving the page never loses it.
 */

export type CutoutState =
  | { phase: "running"; jobId: string; credits: number; held?: boolean }
  | { phase: "done"; jobId: string; credits: number; settled: number | null; note: string | null }
  | { phase: "failed"; jobId: string; credits: number; settled: number | null; reason: string };

export type CutoutQuote = { credits: number } | { reason: string };
export type CutoutStart =
  | { state: "running" }
  | { state: "repriced"; credits: number; reason: string }
  | { state: "refused"; reason: string };

export type CutoutsApi = {
  /** By card id, for the project open now. */
  cutouts: Record<string, CutoutState>;
  /** The approximate price of cutting this card out, asked without sending anything (free), or why it cannot be priced. */
  quote: (node: CanvasNode) => Promise<CutoutQuote>;
  /** Sends the cut-out the person approved at `shown` credits. A price that moved since is asked again, never sent. */
  start: (node: CanvasNode, shown: number) => Promise<CutoutStart>;
};

const POLL_MS = 1500;
const PREFIX = "particl:rig-cutout:";
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

type Job = { status?: string; error?: string | null; creditsBilled?: number | null };

/** Every cut-out of this project still running in this browser, by card. */
function runsFor(scope: string, draftId: string): { nodeId: string; key: string; run: CutoutRun }[] {
  const out: { nodeId: string; key: string; run: CutoutRun }[] = [];
  let storage: Storage;
  try { storage = window.localStorage; } catch { return out; }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    let parts: unknown;
    try { parts = JSON.parse(key.slice(PREFIX.length)); } catch { continue; }
    if (!Array.isArray(parts) || parts[0] !== scope || parts[1] !== draftId || typeof parts[2] !== "string") continue;
    const run = readCutoutRun(storage.getItem(key));
    if (run) out.push({ nodeId: parts[2], key, run });
  }
  return out;
}

export function useCutouts({ scope, draftId, current, file, toast }: {
  scope: string;
  draftId: string | null;
  /** The draft as it is now (a ref read, never stale). */
  current: () => Project | null;
  /** Files a finished cut-out on its card; the refusal, or null. */
  file: (nodeId: string, sourceAssetId: string, jobId: string) => string | null;
  toast: (message: string) => void;
}): CutoutsApi {
  /* Keyed by project, so another project shows nothing stale. */
  const [state, setState] = useState<{ draftId: string; cutouts: Record<string, CutoutState> } | null>(null);
  const cutouts = useMemo(() => (draftId && state?.draftId === draftId ? state.cutouts : {}), [draftId, state]);
  const put = useCallback((id: string, nodeId: string, next: CutoutState) => {
    setState((s) => ({ draftId: id, cutouts: { ...(s?.draftId === id ? s.cutouts : {}), [nodeId]: next } }));
  }, []);
  const [wake, setWake] = useState(0);

  /* Follow every cut-out of this project that is still running; file each one on its card when it finishes. */
  const busy = useRef(false);
  useEffect(() => {
    if (!draftId) return;
    let stopped = false;
    const tick = async () => {
      if (busy.current || stopped) return;
      const runs = runsFor(scope, draftId);
      if (!runs.length) return;
      busy.current = true;
      try {
        for (const { nodeId, key, run } of runs) {
          let job: Job | null = null;
          try { job = (await draftRequest<{ generation?: Job }>(`/api/jobs/${encodeURIComponent(run.jobId)}`, scope)).generation ?? null; }
          catch (error) {
            /* Gone from the library: nothing to file. Anything else (no connection): asked again next time. */
            if ((error as { status?: number }).status === 404) {
              window.localStorage.removeItem(key);
              put(draftId, nodeId, { phase: "failed", jobId: run.jobId, credits: run.credits, settled: null, reason: "That cut-out is no longer in the production's library." });
            }
            continue;
          }
          if (stopped) return;
          const status = String(job?.status ?? "");
          const settled = typeof job?.creditsBilled === "number" ? job.creditsBilled : null;
          if (!TERMINAL.has(status)) { put(draftId, nodeId, { phase: "running", jobId: run.jobId, credits: run.credits, ...(status === "held" ? { held: true } : {}) }); continue; }
          if (status === "succeeded") {
            /* Filed only on the project it was made for, once that project is open here. */
            if (current()?.id !== draftId) continue;
            const note = file(nodeId, run.sourceAssetId, run.jobId);
            window.localStorage.removeItem(key);
            put(draftId, nodeId, { phase: "done", jobId: run.jobId, credits: run.credits, settled, note });
            const title = current()?.nodes.find((n) => n.id === nodeId)?.title ?? "The card";
            toast(note ?? `${title} · cut out. The new version is its source now${settled !== null ? ` · ${formatCredits(settled)} settled` : ""}.`);
          } else {
            window.localStorage.removeItem(key);
            put(draftId, nodeId, { phase: "failed", jobId: run.jobId, credits: run.credits, settled, reason: neutralCopy(job?.error || "The cut-out did not finish.", "The cut-out did not finish.") });
          }
        }
      } finally { busy.current = false; }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [scope, draftId, current, file, toast, put, wake]);

  const quote = useCallback(async (node: CanvasNode): Promise<CutoutQuote> => {
    const project = current();
    if (!project) return { reason: "Open a project first." };
    const input = cutoutRequest(project, node);
    if (!input) return { reason: cutoutProblem(project, node, false) ?? "This card cannot be cut out." };
    try {
      return { credits: (await quoteDispatch(scope, { endpoint: "/api/generate", input })).credits };
    } catch (error) {
      /* No estimate, no cut-out: nothing is sent without a price. */
      return { reason: neutralCopy(error instanceof Error ? error.message : "The cut-out could not be priced right now.", "The cut-out could not be priced right now. Nothing was sent.") };
    }
  }, [scope, current]);

  const start = useCallback(async (node: CanvasNode, shown: number): Promise<CutoutStart> => {
    const project = current();
    if (!project) return { state: "refused", reason: "Open a project first." };
    const input = cutoutRequest(project, node);
    if (!input || !node.assetId) return { state: "refused", reason: cutoutProblem(project, node, false) ?? "This card cannot be cut out." };
    const outcome = await dispatchGeneration({
      scope, storageId: cutoutClaimKey(scope, project.id, node.id), shown, remember: false,
      request: { endpoint: "/api/generate", input },
    });
    if (outcome.state === "repriced") return { state: "repriced", credits: outcome.credits, reason: outcome.reason };
    if (outcome.state === "refused") return { state: "refused", reason: outcome.reason };
    const run: CutoutRun = { jobId: outcome.jobId, sourceAssetId: node.assetId, credits: outcome.credits };
    try { window.localStorage.setItem(cutoutRunKey(scope, project.id, node.id), JSON.stringify(run)); } catch { /* followed while the page is open */ }
    put(project.id, node.id, { phase: "running", jobId: run.jobId, credits: run.credits, ...(outcome.status === "held" ? { held: true } : {}) });
    setWake((n) => n + 1);
    return { state: "running" };
  }, [scope, current, put]);

  return { cutouts, quote, start };
}
