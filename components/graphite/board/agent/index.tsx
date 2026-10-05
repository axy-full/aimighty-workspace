"use client";
import { useEffect, useState, type ComponentType } from "react";
import { useShell } from "@/lib/shell/state";
import { DOCK_WIDTH } from "@/lib/board/geometry";
import type { BoardAgentView } from "@/lib/board/types";
import { runNeedsYou } from "@/lib/shell/board-agent";
import type { BoardCtx } from "../cards/types";
import { showQuestions } from "../cards/questions/model";
import { AgentRail, BoardAgentPanel } from "./BoardAgentPanel";
import { useAgentRun } from "./use-board-agent";

/*
 * Stream 7's docked Atomik panel on the board (340 px open, a 56 px rail collapsed) and the board's Atomik seam
 * (Start on the empty board, the run for the cards). The panel reads today's board agent (lib/workbench/rig-agent*.ts
 * through the team canvas route); its approvals go through the one approvals queue.
 */
export type BoardStartInput = { words: string; aspect: string; seconds: number | null; attachments: string[] };
export type BoardAgentSeam = {
  /** What "Start" costs (Atomik's thinking), from the server's estimate; null while the board has no Atomik. */
  startPrice: { credits: number | null; state: "loading" | "ready" | "unavailable" } | null;
  /** Starts Atomik on this board (a person pressed Start at the price shown); null while the board has no Atomik. Resolves to a refusal, or null. */
  start: ((input: BoardStartInput) => Promise<string | null>) | null;
  /** The board agent's durable run, as the server holds it (null: none yet, or not read yet). */
  run: BoardAgentView | null;
};

export function useBoardAgent(): BoardAgentSeam {
  const agent = useAgentRun();
  const answer = agent.answer;
  const planning = agent.terms?.planning ?? null;
  const start = async (input: BoardStartInput): Promise<string | null> => {
    if (planning === null) return "Atomik’s thinking can’t be priced right now.";
    /* Start is the person's press at this figure: if it has moved, nothing is asked and the button shows the new one. */
    await agent.refresh();
    const now = agent.latestPlanning();
    if (now !== null && now > planning) return `Atomik’s thinking now costs up to ${now} cr, not ${planning} cr. Press Start again at the new price.`;
    return agent.plan(input.words, planning, { aspect: input.aspect, seconds: input.seconds });
  };
  if (!answer || !answer.enabled) return { startPrice: null, start: null, run: answer?.run ?? null };
  return {
    startPrice: planning !== null ? { credits: planning, state: "ready" } : agent.ready ? { credits: null, state: "unavailable" } : { credits: null, state: "loading" },
    start,
    run: answer.run,
  };
}

export type BoardAgentDockProps = { ctx: BoardCtx; open: boolean; onOpenChange: (open: boolean) => void };
/** The dock has an open panel: the board reserves 340 px when it is open. */
export const DOCK_PANEL = true;

export const BoardAgentDock: ComponentType<BoardAgentDockProps> = function BoardAgentDock({ ctx, open, onOpenChange }) {
  const shell = useShell();
  const { setDockRight } = shell;
  /* Make sits beside the dock, never under it (the shell's --board-dock). */
  useEffect(() => {
    setDockRight(open ? DOCK_WIDTH.open : DOCK_WIDTH.closed);
    return () => setDockRight(0);
  }, [open, setDockRight]);
  const agent = useAgentRun();
  const run = agent.answer?.run ?? null;
  /* Opens itself once when the board agent first needs this person (a proposal to approve), never again after it is closed. */
  const [offered, setOffered] = useState<string | null>(null);
  const needs = runNeedsYou(run);
  /* …and once when the panel has questions to ask (a brief and no look yet, README § 3.1 b), so the board opens on them. */
  const asking = agent.ready && showQuestions(ctx.project, run);
  const key = needs && run ? `${run.id}:${run.state}` : asking ? "questions" : null;
  useEffect(() => {
    if (!key || offered === key) return;
    setOffered(key); // eslint-disable-line react-hooks/set-state-in-effect -- one shot per state
    onOpenChange(true);
  }, [key, offered, onOpenChange]);
  return (
    <aside className="bd-dock" data-open={open ? "true" : "false"} aria-label="Atomik" data-testid="board-agent-dock">
      {open ? <BoardAgentPanel ctx={ctx} onCollapse={() => onOpenChange(false)} /> : <AgentRail onOpen={() => onOpenChange(true)} needs={needs} />}
    </aside>
  );
};
