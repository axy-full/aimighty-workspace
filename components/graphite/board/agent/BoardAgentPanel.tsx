"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShell } from "@/lib/shell/state";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { agentAsk, runNeedsYou } from "@/lib/shell/board-agent";
import { useProvideBoardSeam } from "../BoardContext";
import { BoardQuestions } from "../cards/questions/BoardQuestions";
import { showQuestions } from "../cards/questions/model";
import { DrawStoryboard } from "../cards/storyboard/DrawStoryboard";
import type { BoardCtx } from "../cards/types";
import { spendAttrsOf } from "@/lib/spend";
import { usePriceTitle } from "../../Price";
import { CrewReview } from "./CrewReview";
import { RecordTab } from "./RecordTab";
import { AgentLines } from "./AgentLines";
import { useAgentRun } from "./use-board-agent";
import "./agent.css";

/*
 * The board's docked Atomik panel (design/particl-graphite/README.md § 3.1): 340 px right of the canvas, 56 px as a
 * rail. Atomik's lines with their one action each, and under them "Ask Atomik…" with its price. The price on the ask
 * button is the code's planning figure for this board and is the approval: the ask is sent with it as the run's limit
 * (the same call as Home's Start), and every render after it asks again at its own price.
 */
const SPARK = "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z";

export function BoardAgentPanel({ ctx, onCollapse }: { ctx: BoardCtx; onCollapse: () => void }) {
  const agent = useAgentRun();
  const approvals = useApprovals();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const shell = useShell();
  /* The design's frames: m is Crew review, n the Record (old Crew links land on them). */
  const frame = shell.params.frame ?? null;
  const [tab, setTab] = useState<"atomik" | "record">(frame === "n" ? "record" : "atomik");
  const [crew, setCrew] = useState(frame === "m");
  /* The panel stays mounted while the address moves: the board's own "Crew review of the cut" card (and an old Crew link
     followed from inside the board) lands on frame m (or n) after the panel has been drawn, and must open that view too. */
  const [seenFrame, setSeenFrame] = useState(frame);
  if (frame !== seenFrame) {
    setSeenFrame(frame);
    if (frame === "m") { setTab("atomik"); setCrew(true); }
    else if (frame === "n") setTab("record");
  }
  const box = useRef<HTMLTextAreaElement>(null);
  /* ctx.askAtomik(words): the panel with these words in its box, never sent. */
  const fill = useCallback((text?: string) => { if (text) setWords(text); box.current?.focus(); }, []);
  useProvideBoardSeam("atomik", fill);

  const answer = agent.answer;
  const run = answer?.run ?? null;
  /* The queue is read slowly while nothing waits: read it again as the run moves to something that waits for a person. */
  const moved = run ? `${run.id}:${run.state}:${run.paid.map((p) => p.state).join(",")}` : "";
  const { refresh: reread } = approvals;
  useEffect(() => { if (moved) void reread(); }, [moved, reread]);
  /* The sample's line on the sample production, or anywhere in the sample workspace (BoardView's gate): nothing here spends. */
  const sample: string | null = ctx.exploreOnly ?? null;
  const ask = agentAsk({ read: agent.ready, enabled: answer?.enabled ?? false, run, planning: agent.terms?.planning ?? null, words, busy, sample: sample !== null, offline: ctx.offline });
  const title = usePriceTitle(ask.price);
  const send = async () => {
    if (ask.disabled || !ask.price || ask.price.kind === "free") return;
    setBusy(true);
    setSaid(null);
    const pressed = ask.price.credits;
    /* The price may have moved since it was read: ask again at the new one only when the person has pressed it. */
    await agent.refresh();
    const now = agent.latestPlanning();
    const why = now !== null && now > pressed ? `Atomik’s thinking now costs up to ${now} cr, not ${pressed} cr. Press Ask again at the new price.`
      : await agent.plan(words, pressed, { aspect: ctx.project.aspect || null });
    setBusy(false);
    if (why) setSaid(why); else setWords("");
  };

  return (
    <div className="ag" data-testid="board-agent-panel" data-needs={runNeedsYou(run) ? "" : undefined}>
      <div className="ag-head">
        <span className="ag-seg" role="tablist" aria-label="Atomik panel">
          <button type="button" role="tab" aria-selected={tab === "atomik"} onClick={() => setTab("atomik")} data-testid="agent-tab-atomik">Atomik</button>
          <button type="button" role="tab" aria-selected={tab === "record"} onClick={() => setTab("record")} data-testid="agent-tab-record">Record</button>
        </span>
        <button type="button" className="ag-collapse" onClick={onCollapse} aria-label="Collapse Atomik" data-testid="agent-collapse">›</button>
      </div>
      {tab === "record" ? <RecordTab ctx={ctx} onAtomik={() => setTab("atomik")} /> : (
      <div className="ag-body">
        <AgentLines agent={agent} approvals={approvals} sample={sample} />
        {crew ? <CrewReview ctx={ctx} /> : null}
        {showQuestions(ctx.project, run) ? <BoardQuestions readOnly={ctx.offline ? "Needs a connection" : null} exploreOnly={sample} /> : null}
        <DrawStoryboard readOnly={ctx.offline ? "Needs a connection" : null} exploreOnly={sample} />
        {crew ? null : <button type="button" className="ag-link ag-crew-open" onClick={() => setCrew(true)} data-testid="crew-open">Ask the crew</button>}
      </div>)}
      {tab === "atomik" ? <div className="ag-compose">
        <div className="ag-box">
          <textarea ref={box} aria-label="Ask Atomik" placeholder="Ask Atomik…" rows={2} value={words} maxLength={2000} disabled={sample !== null} onChange={(e) => { setWords(e.target.value); setSaid(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} data-testid="agent-input" />
          <button type="button" className="ag-btn ag-btn-primary ag-ask" disabled={ask.disabled} aria-busy={busy || undefined} title={title ?? undefined} onClick={() => void send()} data-testid="agent-ask" {...spendAttrsOf(ask.price)}>{ask.label}</button>
        </div>
        {said ?? ask.reason ? <p className="ag-note" role="status" data-testid="agent-ask-note">{said ?? ask.reason}</p> : null}
      </div> : null}
    </div>
  );
}

/** The dock's collapsed rail: the spark and "Atomik", lit while something needs this person. */
export function AgentRail({ onOpen, needs }: { onOpen: () => void; needs: boolean }) {
  return (
    <button type="button" className="bd-dock-rail" onClick={onOpen} aria-label="Open Atomik" data-testid="agent-rail">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={SPARK} /></svg>
      <span>Atomik</span>
      {needs ? <span className="ag-rail-dot" aria-label="Needs you" /> : null}
    </button>
  );
}
