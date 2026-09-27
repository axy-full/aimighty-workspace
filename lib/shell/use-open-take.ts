"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { findProjectTake } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { CONFIRM } from "./confirmations";
import { useConfirm } from "./use-confirm";

/**
 * A finished result opens in Takes as that take, selected: the Library pages
 * back to it first (a result is filed at its run's own time, so an older one
 * can sit past the loaded pages). If it is not there, nothing moves but a
 * note. `opening` names the result being looked for, keyed by the caller.
 */
export function useOpenTake(scope: string, project: Project | null) {
  const ws = useWorkspace();
  const { open } = useConfirm();
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const openTake = useCallback(async (key: string, generationId: string | null | undefined, since?: number) => {
    if (!generationId || !project) { ws.toast("This result's original is not available yet."); return; }
    setOpening(key);
    const found = await findProjectTake(scope, project.id, `generation:${generationId}`, since).catch(() => false);
    if (!alive.current) return;
    setOpening(null);
    if (!found) { ws.toast("This result is not in the project's Library."); return; }
    open(CONFIRM.take(generationId));
  }, [scope, project, ws, open]);
  return { openTake, opening };
}
