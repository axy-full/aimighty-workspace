"use client";
import { useEffect, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import type { NodeAudioSetup } from "@/lib/workbench/generation-audio";

/**
 * What the workspace's sound engine offers: its speech models, the voices of the default one, and whether music can be made. The
 * same read Make's sound form makes (GET /api/audio, with this workspace's scope header), so an answer is the workspace's own.
 * `null` while it loads; `{ failed }` when it could not be read.
 */
export type AudioSetupRead = { setup: NodeAudioSetup | null; failed: string | null };
export function useAudioSetup(scope: string): AudioSetupRead {
  const [read, setRead] = useState<{ scope: string; setup: NodeAudioSetup | null; failed: string | null } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    studioRequest<NodeAudioSetup>("/api/audio", { signal: abort.signal, headers: { "X-Workbench-Scope": scope } })
      .then((setup) => { if (!abort.signal.aborted) setRead({ scope, setup, failed: null }); })
      .catch((cause: unknown) => { if (!abort.signal.aborted) setRead({ scope, setup: null, failed: cause instanceof Error && cause.message ? cause.message : "The voices could not be read." }); });
    return () => abort.abort();
  }, [scope]);
  return read && read.scope === scope ? { setup: read.setup, failed: read.failed } : { setup: null, failed: null };
}
