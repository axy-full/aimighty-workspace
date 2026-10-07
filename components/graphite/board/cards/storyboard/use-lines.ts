"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_BOARDS, lineDrawingRequest } from "@/lib/production/boards";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { exact, priceSum, type PriceValue } from "@/lib/shell/price-words";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { frameToDraw, framePicture, withPendingFrame } from "./model";
import { lineState } from "./lines-model";
import type { DraftSeam } from "./use-frames";

/**
 * Line drawings of storyboard frames, on the same still path the storyboard is drawn on (lead decision 28, no new money
 * behaviour): each frame's request is priced by the server (/api/generate/quote, the image engine's own price), and a person's one
 * press sends them one by one at the prices shown (dispatchGeneration with `shown`), stopping at the first refusal or price that
 * moved. Each job is kept on its frame while it renders (withPendingFrame), and the frame poller lands it as the frame's next take.
 * Nothing is quoted for a frame that already has a line drawing, and nothing is ever sent without a press.
 */

export type LineDrawings = {
  /** This frame's price from the server; null while it is unread or unreadable. */
  own: PriceValue | null;
  /** The other frames' that still lack a line drawing (those it can send together); `price` null while any is unread. */
  others: { ids: string[]; price: PriceValue | null };
  pricing: "none" | "loading" | "ready" | "error";
  tryAgain: () => void;
  /** Sends these frames at the prices shown. Resolves to how many were sent. */
  send: (ids: string[]) => Promise<number>;
  busy: boolean;
  problem: string | null;
};

export function useLineDrawings(seam: DraftSeam, shotId: string, readOnly: string | null, withOthers: boolean): LineDrawings {
  const { scope, project, apply, save } = seam;
  const latest = useRef(project);
  useEffect(() => { latest.current = project; }, [project]);
  const offering = useMemo(() => {
    if (!project) return [] as string[];
    const frames = Object.keys(project.production?.boards?.frames ?? {});
    return frames.filter((id) => lineState(project, id).offer && (id === shotId || withOthers));
  }, [project, shotId, withOthers]);
  const requests = useMemo(() => {
    if (!project) return {};
    const boards = project.production?.boards ?? DEFAULT_BOARDS;
    return Object.fromEntries(offering.flatMap((id) => {
      const frame = frameToDraw(project, id);
      const source = framePicture(boards.frames[id]);
      const input = frame && source ? lineDrawingRequest(project, boards, frame, source) : null;
      return input ? [[id, { body: generationRequestBody(input) }]] : [];
    }));
  }, [project, offering]);
  const pricing = useStageQuotes(scope, requests);
  const ids = Object.keys(requests);
  const credits = (id: string) => pricing.quotes[id]?.credits;
  const own = credits(shotId) != null ? exact(credits(shotId)) : null;
  const otherIds = ids.filter((id) => id !== shotId);
  const otherPrices = otherIds.map(credits);
  const othersPrice = otherIds.length && otherPrices.every((c) => c != null) ? priceSum(otherPrices.map((c) => exact(c))) : null;
  const failed = ids.filter((id) => pricing.quotes[id]?.error);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const send = useCallback(async (list: string[]) => {
    if (sending.current || readOnly) return 0;
    const start = latest.current;
    if (!start) return 0;
    const shown = list.map((id) => [id, pricing.quotes[id]?.credits ?? null] as const);
    if (!shown.length || shown.some(([, c]) => c == null)) return 0;
    sending.current = true; setBusy(true); setProblem(null);
    let sent = 0;
    try {
      if (!(await save())) { setProblem("Save the project before drawing the lines."); return 0; }
      for (const [id, credits] of shown) {
        const now = latest.current;
        if (!now) break;
        const boards = now.production?.boards ?? DEFAULT_BOARDS;
        const frame = frameToDraw(now, id);
        const source = framePicture(boards.frames[id]);
        const input = frame && source ? lineDrawingRequest(now, boards, frame, source) : null;
        if (!frame || !input || !lineState(now, id).offer) continue;
        const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, now.id, `lines-${id}`), shown: credits!, request: { endpoint: "/api/generate", input } });
        if (outcome.state === "repriced") { pricing.reprice(id, outcome.credits); setProblem(outcome.reason); break; }
        if (outcome.state === "refused") { setProblem(outcome.reason); break; }
        apply((p) => withPendingFrame(p, id, frame, { jobId: outcome.jobId, style: "bw-sketch", at: new Date().toISOString() }));
        sent++;
      }
      if (sent) void save();
      return sent;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The line drawings could not be sent.");
      return sent;
    } finally { sending.current = false; setBusy(false); }
  }, [readOnly, pricing, save, scope, apply]);

  return {
    own, others: { ids: otherIds, price: othersPrice },
    pricing: !ids.length ? "none" : ids.every((id) => credits(id) != null) ? "ready" : failed.length ? "error" : "loading",
    tryAgain: () => { for (const id of failed) pricing.tryAgain(id); },
    send, busy, problem,
  };
}
