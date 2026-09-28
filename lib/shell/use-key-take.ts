"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import type { Generation } from "@/lib/jobs";
import { movedOn, poll } from "@/lib/poll";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { activeMediaJob } from "@/lib/workbench/job-recovery";
import { dispatchGeneration, quoteDispatch, type DispatchRequest } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { neutralCopy } from "@/lib/workspace/rig";
import { projectTakes } from "@/lib/workspace/takes";
import { announceJob } from "./jobs-bus";
import type { KeyEstimate } from "./key-estimate";

/**
 * One composer's take on Particl's API key (Viral's Motion Transfer and
 * Object Swap, Business › Image ads), through the one workspace-credit path
 * every Studio composer uses (lib/workspace/generate-submit.ts):
 *
 *  - the estimate on the button is POST /api/generate/quote for exactly the
 *    body that will be sent — admission's own validation and the provider's
 *    live estimate through Particl's credit terms, reserved nowhere;
 *  - a press prices it again, sends nothing if the figure moved (the new one
 *    is shown to approve), claims the attempt in recovery storage and posts
 *    POST /api/generate once, with that figure as the ceiling and the quote's
 *    fingerprint; a claim whose reply was lost is asked about by its own key
 *    on the next press and never sent twice;
 *  - the take is then read at lib/poll's pace (GET /api/jobs/:id, which also
 *    collects the finished original) until it settles, and the project's
 *    Library is read again so Takes shows it;
 *  - a take still queued at the provider can be cancelled
 *    (POST /api/generations/:id/cancel); the provider's own outcome is what the
 *    take then says.
 *
 * No new money path: nothing here prices, reserves or settles by itself.
 */
export type KeyRun =
  | { phase: "idle" }
  | { phase: "submitting"; credits: number | null }
  | { phase: "running"; jobId: string; credits: number; held: boolean; generation: Generation | null }
  | { phase: "done"; jobId: string; credits: number; generation: Generation }
  | { phase: "failed"; error: string; jobId: string | null; generation: Generation | null };

/** How long an estimate on the button is leaned on before it is read again (a press always prices again first). */
export const KEY_ESTIMATE_LIFETIME_MS = 5 * 60_000;
const NO_ESTIMATE = "The estimate could not be read. Nothing was sent.";

/** A settled take's words, the Takes page's own (lib/workspace/takes.ts): failed and not billed only when the ledger says so. */
export function settledWords(generation: Generation): string {
  const [take] = projectTakes([{ origin: "generation", value: generation }]);
  if (generation.status === "cancelled") return take.failedUnbilled ? "Cancelled · not billed." : "Cancelled.";
  const why = take.reason ? ` ${take.reason.replace(/[.!?]?$/, ".")}` : "";
  return take.failedUnbilled ? `Failed · not billed.${why}` : `Failed.${why}`;
}

export function useKeyTake(scope: string, projectId: string | null, slot: string) {
  const [estimate, setEstimate] = useState<KeyEstimate | null>(null);
  const [run, setRun] = useState<KeyRun>({ phase: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  /* The project the answers belong to: a reply for a project no longer open is dropped. */
  const project = useRef(projectId);
  useEffect(() => { project.current = projectId; });

  /** The estimate for exactly this request; `key` names what it prices. */
  const quote = useCallback(async (request: DispatchRequest, key: string) => {
    if (!projectId || !scope) return;
    const asked = projectId;
    try {
      const fresh = await quoteDispatch(scope, request);
      if (project.current !== asked) return;
      setEstimate({ key, credits: fresh.credits, expiresAt: Date.now() + KEY_ESTIMATE_LIFETIME_MS, error: null });
    } catch (error) {
      if (project.current !== asked) return;
      const said = error instanceof Error ? neutralCopy(error.message, NO_ESTIMATE) : NO_ESTIMATE;
      /* A refusal is said until the input changes; anything else is asked again after a short wait. */
      const refused = error instanceof StudioRequestError && error.status >= 400 && error.status < 500;
      setEstimate({ key, credits: null, expiresAt: Date.now() + (refused ? KEY_ESTIMATE_LIFETIME_MS : 30_000), error: said });
    }
  }, [scope, projectId]);

  /** Press: price again, send once at that figure (never twice), then follow the take. */
  const submit = useCallback(async (request: DispatchRequest, key: string, shown: number | null) => {
    if (!projectId || !scope) return;
    setNote(null);
    setRun({ phase: "submitting", credits: shown });
    const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, projectId, slot), shown, request });
    if (project.current !== projectId) return;
    if (outcome.state === "repriced") {
      setEstimate({ key, credits: outcome.credits, expiresAt: Date.now() + KEY_ESTIMATE_LIFETIME_MS, error: null });
      setRun({ phase: "idle" });
      setNote(`The estimate is now about ${outcome.credits.toLocaleString("en-US")} cr. Press again to approve it.`);
      return;
    }
    if (outcome.state === "refused") { setRun({ phase: "failed", error: outcome.reason, jobId: null, generation: null }); return; }
    setRun({ phase: "running", jobId: outcome.jobId, credits: outcome.credits, held: outcome.status === "held", generation: null });
  }, [scope, projectId, slot]);

  /* The take that was sent, read until it settles; once it lands the Library is read again. */
  const following = run.phase === "running" ? run.jobId : null;
  useEffect(() => {
    if (!following || !scope) return;
    const moved = movedOn();
    const poller = poll({
      immediate: true,
      read: (signal) => studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(following)}`, { signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" }),
      moved: (data) => moved(following, data.generation.status),
      done: (data) => !activeMediaJob(data.generation),
      onValue: (data) => {
        const generation = data.generation;
        setRun((prev) => {
          if (prev.phase !== "running" || prev.jobId !== following) return prev;
          if (generation.status === "succeeded") return { phase: "done", jobId: following, credits: prev.credits, generation };
          if (!activeMediaJob(generation)) return { phase: "failed", error: settledWords(generation), jobId: following, generation };
          return { ...prev, held: generation.status === "held", generation };
        });
        if (!activeMediaJob(generation)) {
          announceJob(following);
          if (project.current) void refreshProjectLibrary(scope, project.current);
        }
      },
      /* Gone, or not this person's: asking again cannot help. */
      onError: (error) => (error instanceof StudioRequestError && (error.status === 404 || error.status === 403) ? "stop" : undefined),
    });
    return () => poller.stop();
  }, [following, scope]);

  /** Cancel a take still queued at the provider; the take then says what the provider did. */
  const cancel = useCallback(async (jobId: string) => {
    if (!scope || cancelling) return;
    setCancelling(jobId);
    setNote(null);
    try {
      const result = await studioRequest<{ status?: string }>(`/api/generations/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: { "X-Workbench-Scope": scope } });
      setNote(result.status === "requested" ? "Cancel requested. The take says what the provider did once it answers." : "It had already started, so it could not be cancelled.");
    } catch (error) {
      setNote(error instanceof Error ? neutralCopy(error.message, "The cancel could not be confirmed. Try again.") : "The cancel could not be confirmed. Try again.");
    } finally {
      setCancelling(null);
      if (project.current) void refreshProjectLibrary(scope, project.current);
    }
  }, [scope, cancelling]);

  return { estimate, run, note, cancelling, quote, submit, cancel, reset: () => setRun({ phase: "idle" }), dismissNote: () => setNote(null) };
}
