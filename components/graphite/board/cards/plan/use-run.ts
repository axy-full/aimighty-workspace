"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentRunView, RigAgentState } from "@/lib/workbench/rig-agent-plan";
import { usePlanUiVersion } from "./ui";

/*
 * Atomik's run on this production, read for the plan card: today's team-canvas GET with `agent=1` (the same read
 * the Rig's run card makes, and stream 7's panel makes), often while Atomik works and now and then otherwise, and
 * at once when the card acted (AGENT_CHANGED). Read-only: nothing here changes a run.
 */
export const AGENT_CHANGED = "particl:board-agent-changed";
const API = "/api/workbench/team-canvas";
const BUSY_MS = 1500;
const IDLE_MS = 12_000;
const ACTIVE: readonly RigAgentState[] = ["planning", "running"];

type Answer = { enabled: boolean; run: RigAgentRunView | null };
function isAnswer(value: unknown): value is { agent: Answer } {
  const agent = (value as { agent?: Answer } | null)?.agent;
  return !!agent && typeof agent.enabled === "boolean" && (agent.run === null || (typeof agent.run === "object" && typeof agent.run.id === "string"));
}

/**
 * The run for the board's cards. `joined` is true once the Rig has joined its team canvas (the read waits for it, as
 * the Rig's run card does). The returned run is a new object whenever a plan's steps are folded or unfolded, so the
 * board lays the card out again at its new height.
 */
export function usePlanRun(args: { scope: string; productionId: string | null; draftId: string | null; joined: boolean; enabled?: boolean }): RigAgentRunView | null {
  const { scope, productionId, draftId, joined, enabled = true } = args;
  const [answer, setAnswer] = useState<{ pid: string; value: Answer } | null>(null);
  const uiVersion = usePlanUiVersion();
  const read = useCallback(async (pid: string) => {
    try {
      const query = `${API}?productionId=${encodeURIComponent(pid)}&agent=1${draftId ? `&projectId=${encodeURIComponent(draftId)}` : ""}`;
      const value = await draftRequest<unknown>(query, scope);
      if (isAnswer(value)) setAnswer({ pid, value: value.agent });
    } catch { /* the next read tries again; the card is an extra */ }
  }, [scope, draftId]);

  const mine = answer && answer.pid === productionId ? answer.value : null;
  const active = !!mine?.run && ACTIVE.includes(mine.run.state);
  const watching = !mine || mine.enabled || !!mine.run;
  useEffect(() => {
    if (!enabled || !productionId || !joined) return;
    let stopped = false;
    const tick = () => { if (!stopped && document.visibilityState !== "hidden") void read(productionId); };
    tick();
    window.addEventListener(AGENT_CHANGED, tick);
    const every = watching ? setInterval(tick, active ? BUSY_MS : IDLE_MS) : null;
    return () => { stopped = true; window.removeEventListener(AGENT_CHANGED, tick); if (every) clearInterval(every); };
  }, [enabled, productionId, joined, active, watching, read]);

  const run = mine?.run ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh object when the plan's folds change (the layout reads them)
  return useMemo(() => (run ? { ...run } : null), [run, uiVersion]);
}
