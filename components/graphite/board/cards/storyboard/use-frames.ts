"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { failureLine } from "@/lib/errors";
import { DEFAULT_BOARDS, frameRequest } from "@/lib/production/boards";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import type { TakeFailure } from "@/lib/providerOutcome";
import { exact, priceSum, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import type { Project } from "@/lib/workbench/studio";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { pickedLook } from "../looks/model";
import { frameToDraw, pendingFrames, storyboard, withLandedFrame, withPendingFrame } from "./model";

/**
 * Drawing the storyboard, on the path the Boards stage has always used (lead decision 28): every shot with no
 * frame is priced by the server (/api/generate/quote), and a person's one press sends them one by one at the
 * prices shown (dispatchGeneration with `shown`), stopping at the first refusal or price that moved. Each job is
 * kept on its frame while it renders, under the same recovery key the Boards stage uses (`board-<shot>`), so a
 * reply that was lost is asked about, never sent twice. No new money behaviour.
 *
 * Atomik's panel offers it as its next step (stream 7); the Storyboard group polls what is on its way.
 */

/** The Rig seam this needs (components/workspace/rig/RigProvider.tsx), or the board's own handle on it. */
export type DraftSeam = {
  scope: string;
  project: Project | null;
  apply: (fn: (project: Project) => Project) => string | null;
  save: () => Promise<boolean>;
};

export type StoryboardDraw = {
  /** Shots with no frame and none on its way. */
  count: number;
  /** What drawing them costs, from the server; null while any is unpriced. */
  price: PriceValue | null;
  /** "loading" while quotes are read; "error" when one could not be read (say "Try again"). */
  pricing: "none" | "loading" | "ready" | "error";
  tryAgain: () => void;
  /** Sends them, at the price shown. Resolves to how many were sent. */
  draw: () => Promise<number>;
  busy: boolean;
  /** What stopped the last press (a refusal, a price that moved, a save that failed), or null. */
  problem: string | null;
  /** Why it can't be pressed now, or null. */
  blocked: string | null;
};

export function useStoryboardDraw(seam: DraftSeam, readOnly: string | null): StoryboardDraw {
  const { scope, project, apply, save } = seam;
  const latest = useRef(project);
  useEffect(() => { latest.current = project; }, [project]);
  const missing = useMemo(() => (project ? storyboard(project).missing : []), [project]);
  const requests = useMemo(() => {
    if (!project) return {};
    const boards = project.production?.boards ?? DEFAULT_BOARDS;
    return Object.fromEntries(missing.flatMap((shotId) => {
      const frame = frameToDraw(project, shotId);
      const input = frame ? frameRequest(project, boards, frame, pickedLook(project)) : null;
      return input ? [[shotId, { body: generationRequestBody(input) }]] : [];
    }));
  }, [project, missing]);
  const pricing = useStageQuotes(scope, requests);
  const ids = Object.keys(requests);
  const prices = ids.map((id) => pricing.quotes[id]?.credits);
  const price = ids.length && prices.every((c) => c != null) ? priceSum(prices.map((c) => exact(c))) : null;
  const failed = ids.filter((id) => pricing.quotes[id]?.error);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const draw = useCallback(async () => {
    if (sending.current || readOnly) return 0;
    const start = latest.current;
    if (!start) return 0;
    const shown = Object.fromEntries(Object.keys(requests).map((id) => [id, pricing.quotes[id]?.credits ?? null]));
    if (!Object.keys(shown).length || Object.values(shown).some((c) => c == null)) return 0;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    let sent = 0;
    try {
      if (!(await save())) { setProblem("Save the project before drawing the storyboard."); return 0; }
      for (const [shotId, credits] of Object.entries(shown)) {
        const now = latest.current;
        if (!now) break;
        const boards = now.production?.boards ?? DEFAULT_BOARDS;
        const frame = frameToDraw(now, shotId);
        const input = frame ? frameRequest(now, boards, frame, pickedLook(now)) : null;
        if (!frame || !input) continue;
        const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, now.id, `board-${shotId}`), shown: credits!, request: { endpoint: "/api/generate", input } });
        if (outcome.state === "repriced") { pricing.reprice(shotId, outcome.credits); setProblem(outcome.reason); break; }
        if (outcome.state === "refused") { setProblem(outcome.reason); break; }
        apply((p) => withPendingFrame(p, shotId, frame, { jobId: outcome.jobId, style: frame.style ?? boards.style, at: new Date().toISOString() }));
        sent++;
      }
      if (sent) void save();
      return sent;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The storyboard could not be sent.");
      return sent;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }, [readOnly, requests, pricing, save, scope, apply]);

  const blocked = readOnly ?? (busy ? "Sending frames…" : !missing.length ? "Every shot has a frame." : null);
  return {
    count: missing.length, price,
    pricing: !ids.length ? "none" : price ? "ready" : failed.length ? "error" : "loading",
    tryAgain: () => { for (const id of failed) pricing.tryAgain(id); },
    draw, busy, problem, blocked,
  };
}

type Generation = { id: string; status: string; error?: string | null; failure?: TakeFailure | null };
const DONE = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Frames on their way: each job read every few seconds until it ends, then filed on its frame (a picture, or
 * the failure in the provider's words). Free reads only. Each frame card on the board polls its own shot
 * (`shotId`), so no job is read twice. Returns what failed, by shot, for its tile.
 */
export function useFramePoller(seam: DraftSeam, shotId?: string): Record<string, string> {
  const { scope, project, apply, save } = seam;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const jobs = project ? pendingFrames(project).filter((j) => !shotId || j.shotId === shotId) : [];
  const key = jobs.map((j) => `${j.shotId}:${j.jobId}`).join(",");
  const projectId = project?.id ?? null;
  const work = useRef({ apply, save });
  useEffect(() => { work.current = { apply, save }; }, [apply, save]);
  useEffect(() => {
    if (!key || !projectId) return;
    const list = key.split(",").map((pair) => { const [shotId, jobId] = pair.split(":"); return { shotId, jobId }; });
    let alive = true, reading = false;
    const controller = new AbortController();
    const tick = async () => {
      if (reading) return;
      reading = true;
      for (const { shotId, jobId } of list) {
        try {
          const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope } });
          if (!alive || !DONE.has(generation.status)) continue;
          const ok = generation.status === "succeeded";
          work.current.apply((p) => withLandedFrame(p, shotId, jobId, ok ? generation.id : null, new Date().toISOString()));
          if (!ok) setErrors((e) => ({ ...e, [shotId]: generation.failure ? failureLine(generation.failure).text : generation.error || "This frame did not render." }));
          else setErrors((e) => { if (!(shotId in e)) return e; const next = { ...e }; delete next[shotId]; return next; });
          void work.current.save().then(() => { if (ok) void refreshProjectLibrary(scope, projectId); });
        } catch { /* the next look reads it again */ }
        if (!alive) break;
      }
      reading = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  }, [key, scope, projectId]);
  return errors;
}
