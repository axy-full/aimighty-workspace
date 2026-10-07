"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { failureLine } from "@/lib/errors";
import { LOOK_PRESETS, lookPrompt, lookRequest } from "@/lib/production/looks";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import type { TakeFailure } from "@/lib/providerOutcome";
import { exact, priceSum, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { aspectOf, castReference, lookWords, type Answers } from "../questions/model";
import type { DraftSeam } from "../storyboard/use-frames";
import { looks, pendingLooks, withLandedLook, withPendingLook } from "./model";

/**
 * "Show me looks · N cr" (README § 3.1 b–c; lead decision 28): the looks still to make, each priced by the server
 * (/api/generate/quote), sent by a person's one press one by one at the prices shown (dispatchGeneration with
 * `shown`), stopping at the first refusal or price that moved. Each is kept on the draft while it renders, under
 * its own recovery key (`look-<id>`), so a lost reply is asked about and never sent twice. The answers to the
 * questions set the aspect (saved first), the cast reference and the words. No new money behaviour.
 */
export type ShowMeLooks = {
  count: number;
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "error";
  tryAgain: () => void;
  send: () => Promise<number>;
  busy: boolean;
  problem: string | null;
  blocked: string | null;
};

export function useShowMeLooks(seam: DraftSeam, answers: Answers, readOnly: string | null): ShowMeLooks {
  const { scope, project, apply, save } = seam;
  const latest = useRef(project);
  useEffect(() => { latest.current = project; }, [project]);
  const aspect = aspectOf(answers);
  /* Priced as they will be sent: in the aspect the answers chose. */
  const priced = useMemo(() => (project && aspect && project.aspect !== aspect ? { ...project, aspect } : project), [project, aspect]);
  const toMake = useMemo(() => (priced ? looks(priced).toMake : []), [priced]);
  const extra = lookWords(answers);
  /* What a still costs is its model, size and references, not the typed words: the price is read for the looks as the
     answers shape them (aspect, cast picture) without the words, so typing in a field never takes the price away.
     What is sent carries the words, at this price or refused as moved (dispatchGeneration). */
  const reference = useMemo(() => (priced ? castReference(priced, answers) : null), [priced, answers]);
  const requests = useMemo(() => {
    if (!priced) return {};
    return Object.fromEntries(toMake.flatMap((preset) => {
      const input = lookRequest(priced, { prompt: lookPrompt(priced, preset) }, reference);
      return input ? [[preset.id, { body: generationRequestBody(input) }]] : [];
    }));
  }, [priced, toMake, reference]);
  const pricing = useStageQuotes(scope, requests);
  const ids = Object.keys(requests);
  const credits = ids.map((id) => pricing.quotes[id]?.credits);
  const price = ids.length && credits.every((c) => c != null) ? priceSum(credits.map((c) => exact(c))) : null;
  const failed = ids.filter((id) => pricing.quotes[id]?.error);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const send = useCallback(async () => {
    if (sending.current || readOnly || !latest.current) return 0;
    const shown = Object.fromEntries(ids.map((id) => [id, pricing.quotes[id]?.credits ?? null]));
    if (!ids.length || Object.values(shown).some((c) => c == null)) return 0;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    let sent = 0;
    try {
      if (aspect && latest.current.aspect !== aspect) apply((p) => ({ ...p, aspect }));
      if (!(await save())) { setProblem("Save the project before making the looks."); return 0; }
      for (const id of ids) {
        const now = latest.current;
        const preset = LOOK_PRESETS.find((p) => p.id === id);
        if (!now || !preset) continue;
        const prompt = lookPrompt(now, preset, extra);
        const input = lookRequest(now, { prompt }, castReference(now, answers));
        if (!input) continue;
        const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, now.id, `look-${id}`), shown: shown[id]!, request: { endpoint: "/api/generate", input } });
        if (outcome.state === "repriced") { pricing.reprice(id, outcome.credits); setProblem(outcome.reason); break; }
        if (outcome.state === "refused") { setProblem(outcome.reason); break; }
        apply((p) => withPendingLook(p, preset, prompt, { jobId: outcome.jobId, at: new Date().toISOString() }));
        sent++;
      }
      if (sent) void save();
      return sent;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The looks could not be sent.");
      return sent;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }, [readOnly, ids, pricing, aspect, apply, save, extra, scope, answers]);

  return {
    count: toMake.length, price,
    pricing: !ids.length ? "none" : price ? "ready" : failed.length ? "error" : "loading",
    tryAgain: () => { for (const id of failed) pricing.tryAgain(id); },
    send, busy, problem,
    blocked: readOnly ?? (busy ? "Sending looks…" : !toMake.length ? "The four looks are made." : null),
  };
}

type Generation = { id: string; status: string; error?: string | null; failure?: TakeFailure | null };
const DONE = new Set(["succeeded", "failed", "cancelled"]);

/** A look on its way: read until it ends, then filed (a picture, or the failure in the provider's words). One look per caller. */
export function useLookPoller(seam: DraftSeam, id: string): string | null {
  const { scope, project, apply, save } = seam;
  const [error, setError] = useState<string | null>(null);
  const jobs = project ? pendingLooks(project).filter((j) => j.id === id) : [];
  const key = jobs.map((j) => j.jobId).join(",");
  const projectId = project?.id ?? null;
  const work = useRef({ apply, save });
  useEffect(() => { work.current = { apply, save }; }, [apply, save]);
  useEffect(() => {
    if (!key || !projectId) return;
    let alive = true, reading = false;
    const controller = new AbortController();
    const tick = async () => {
      if (reading) return;
      reading = true;
      for (const jobId of key.split(",")) {
        try {
          const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope } });
          if (!alive || !DONE.has(generation.status)) continue;
          const ok = generation.status === "succeeded";
          work.current.apply((p) => withLandedLook(p, id, jobId, ok ? generation.id : null, new Date().toISOString()));
          setError(ok ? null : generation.failure ? failureLine(generation.failure).text : generation.error || "This look did not render.");
          void work.current.save().then(() => { if (ok) void refreshProjectLibrary(scope, projectId); });
        } catch { /* the next look reads it again */ }
        if (!alive) break;
      }
      reading = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  }, [key, scope, projectId, id]);
  return error;
}
