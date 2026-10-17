"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { resolutionQuery, type ResolutionReply } from "@/lib/shell/resolution-control";

/**
 * The Resolution control's options for the engine and settings Make holds: POST /api/generate/resolutions, which prices each size through the
 * quote engine and reserves, holds and sends nothing (lib/resolutionQuote.ts). Read while the control is on the screen; a reply for other
 * settings is never shown for these. A failed read leaves the control on the engine's own list, unpriced.
 */
export function useResolutionOptions(scope: string, input: { model: string | null; ratio: string; duration: number; generateAudio?: boolean }, on: boolean): ResolutionReply | null {
  const scopedFetch = useScopedFetch(scope);
  const body = input.model ? resolutionQuery({ model: input.model, ratio: input.ratio, duration: input.duration, generateAudio: input.generateAudio }) : null;
  const key = body ? JSON.stringify(body) : null;
  const [answer, setAnswer] = useState<{ key: string; reply: ResolutionReply | null } | null>(null);
  const have = answer?.key ?? null;
  useEffect(() => {
    if (!on || !key || have === key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void scopedFetch("/api/generate/resolutions", { method: "POST", headers: { "Content-Type": "application/json" }, body: key, cache: "no-store", signal: controller.signal })
        .then(async (r) => (r.ok ? ((await r.json()) as ResolutionReply) : null))
        .then((reply) => { if (!controller.signal.aborted) setAnswer({ key, reply: reply && Array.isArray(reply.options) ? reply : null }); })
        .catch(() => { if (!controller.signal.aborted) setAnswer({ key, reply: null }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [on, key, have, scopedFetch]);
  const reply = answer && answer.key === key ? answer.reply : null;
  return reply && input.model && reply.model === input.model ? reply : null;
}
