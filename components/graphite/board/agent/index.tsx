"use client";
import { useEffect, useLayoutEffect, useState, type ComponentType } from "react";
import { useShell } from "@/lib/shell/state";
import { DOCK_WIDTH } from "@/lib/board/geometry";
import type { BoardAgentView } from "@/lib/board/types";
import { runNeedsYou } from "@/lib/shell/board-agent";
import { priceWords, upTo } from "@/lib/shell/price-words";
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
  /** What "Start" costs (Atomik's thinking), from the server's estimate with the attached files priced in; null while the board has no Atomik. `problem`: why it can't be priced (the server's words). */
  startPrice: { credits: number | null; /** The same in the engines' dollars, where the server gave it (the house pays them). */ usd?: number | null; state: "loading" | "ready" | "unavailable"; problem?: string } | null;
  /** Starts Atomik on this board (a person pressed Start at the price shown); null while the board has no Atomik. Resolves to a refusal, or null. */
  start: ((input: BoardStartInput) => Promise<string | null>) | null;
  /** The board agent's durable run, as the server holds it (null: none yet, or not read yet). */
  run: BoardAgentView | null;
};

type Priced = { key: string; planning: number | null; usd?: number | null; problem: string | null };
const keyOf = (attachments: readonly string[]) => attachments.join(" ");

/**
 * The board's Atomik seam. `attachments` (`upload:<id>`): the files Start will hand Atomik. They go into the
 * planning call, so they are priced in: with files attached the figure is the server's for those files (the same
 * estimator the charge reserves at), read again on the press; without, the board's shared read.
 */
export function useBoardAgent(attachments: readonly string[] = []): BoardAgentSeam {
  const agent = useAgentRun();
  const answer = agent.answer;
  const enabled = !!answer?.enabled;
  const { quote } = agent;
  const key = keyOf(attachments);
  const [priced, setPriced] = useState<Priced | null>(null);
  useEffect(() => {
    if (!key || !enabled) return;
    let live = true;
    void quote(key.split(" ")).then((got) => { if (live) setPriced({ key, planning: "error" in got ? null : got.planning, usd: "error" in got ? null : got.planningUsd ?? null, problem: "error" in got ? got.error : null }); });
    return () => { live = false; };
  }, [key, enabled, quote]);
  const own = key && priced?.key === key ? priced : null;
  const planning = key ? own?.planning ?? null : agent.terms?.planning ?? null;
  const planningUsd = key ? own?.usd ?? null : agent.terms?.planningUsd ?? null;
  const start = async (input: BoardStartInput): Promise<string | null> => {
    if (planning === null) return "Atomik’s thinking can’t be priced right now.";
    const files = input.attachments;
    if (keyOf(files) !== key) return "The attached files changed. Press Start again at the price shown.";
    /* Start is the person's press at this figure: if it has moved, nothing is asked and the button shows the new one. */
    let now: number | null;
    if (files.length) {
      const got = await quote(files);
      if ("error" in got) { setPriced({ key, planning: null, problem: got.error }); return got.error; }
      now = got.planning;
      if (now !== null) setPriced({ key, planning: now, usd: got.planningUsd ?? null, problem: null });
    } else {
      await agent.refresh();
      now = agent.latestPlanning();
    }
    if (now !== null && now > planning) return `Atomik’s thinking now costs ${priceWords(upTo(now, agent.latestPlanningUsd())) ?? "more"}, not ${priceWords(upTo(planning, planningUsd)) ?? "the price shown"}. Press Start again at the new price.`;
    return agent.plan(input.words, planning, { aspect: input.aspect, seconds: input.seconds }, files);
  };
  if (!answer || !answer.enabled) return { startPrice: null, start: null, run: answer?.run ?? null };
  const startPrice: NonNullable<BoardAgentSeam["startPrice"]> =
    planning !== null ? { credits: planning, usd: planningUsd, state: "ready" }
    : key ? (own ? { credits: null, state: "unavailable", ...(own.problem ? { problem: own.problem } : {}) } : { credits: null, state: "loading" })
    : agent.ready ? { credits: null, state: "unavailable" } : { credits: null, state: "loading" };
  return { startPrice, start, run: answer.run };
}

export type BoardAgentDockProps = { ctx: BoardCtx; open: boolean; onOpenChange: (open: boolean) => void };
/** The dock has an open panel: the board reserves 340 px when it is open. */
export const DOCK_PANEL = true;

export const BoardAgentDock: ComponentType<BoardAgentDockProps> = function BoardAgentDock({ ctx, open, onOpenChange }) {
  const shell = useShell();
  const { setDockRight } = shell;
  /* Make sits beside the dock, never under it (the shell's --board-dock). Told before paint, so no frame shows Make at the
   * old width while the dock has already opened. */
  useLayoutEffect(() => {
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
