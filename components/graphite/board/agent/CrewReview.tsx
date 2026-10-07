"use client";
import { useEffect, useRef, useState } from "react";
import { useShell } from "@/lib/shell/state";
import { useCrew } from "@/lib/crew/use-crew";
import { upTo } from "@/lib/shell/price-words";
import type { BoardCtx } from "../cards/types";
import { spendAttrsOf } from "@/lib/spend";
import { usePriceTitle } from "../../Price";
import { PriceWords } from "./PriceWords";
import { CrewTakeReview } from "../review/CrewTakeReview";

/*
 * Crew review in the docked panel (design/particl-graphite/README.md § 3.1 m; lead decision 21): "Ask the crew" on
 * the room that exists today (lib/crew, lib/workbench/crew.ts), priced and approved like any run. The crew's seated
 * members read the board; **Ask the crew · up to N cr** is a person's press at the round's own quote, sent as its
 * ceiling (`maxCredits`), for exactly one round. What comes back are the room's solutions: **Dismiss** drops one,
 * **Add to brief** files it in the brief (free), and **Open in Make** opens Make with the words filled, where Make
 * shows its own price and a person presses it. Nothing here makes or renders anything.
 */
const GOAL = "Review this board against its brief: flag what breaks the look, the cast or continuity, and the first thing to change.";

export function CrewReview({ ctx }: { ctx: BoardCtx }) {
  const shell = useShell();
  const room = useCrew(ctx.project.id);
  const [problem, setProblem] = useState<string | null>(null);
  const here = useRef<HTMLDivElement>(null);
  /* Opened from the panel or from an old Crew link: it is what the person came for, so it is in view. */
  useEffect(() => { here.current?.scrollIntoView?.({ block: "start" }); }, []);
  const { goal, setGoal } = room;
  /* The crew reads the board: the goal is that review, unless the person wrote another in the room. */
  useEffect(() => { if (!goal.trim()) setGoal(GOAL); }, [goal, setGoal]);
  const price = room.credits == null ? null : upTo(room.credits);
  const title = usePriceTitle(price);
  const open = room.solutions.filter((s) => s.status === "open");
  const reason = room.running ? null : room.blocked;

  const brief = async (id: string) => { setProblem(null); const out = await room.routeSolution(id, "brief"); if (out) ctx.toast("Added to the brief"); else setProblem("That couldn’t be added to the brief."); };
  const make = async (id: string) => {
    setProblem(null);
    const out = await room.routeSolution(id, "gen");
    if (out?.prompt) shell.openMake({ prompt: out.prompt });
    else setProblem("Make couldn’t be opened with that.");
  };

  return (
    <div className="ag-msg" ref={here} data-testid="crew-review">
      {/* The take under review: its notes, Approve and Reject with a reason (gap screens, Crew review). The client link follows at the foot. */}
      <CrewTakeReview ctx={ctx} />
      <span className="ag-eyebrow">Atomik</span>
      <div className="ag-text">The crew reads the board. Open a note in Make or add it to the brief; dismiss the rest.</div>
      <span className="ag-title" id="crew-ask">Ask the crew</span>
      <div className="ag-chips" role="group" aria-labelledby="crew-ask">
        {room.members.map((m) => (
          <button key={m.id} type="button" className="ag-chip" aria-pressed={m.active} disabled={room.running} onClick={() => void room.patchMember(m.id, { active: !m.active })} data-testid="crew-member">{m.name}</button>
        ))}
      </div>
      <div className="ag-actions">
        <button type="button" className="ag-btn ag-btn-primary" disabled={room.blocked !== null || room.running} aria-busy={room.running || undefined} title={title ?? undefined} onClick={() => void room.runRound()} data-testid="crew-ask" {...spendAttrsOf(price)}>
          {room.running ? "The crew is reading…" : <>Ask the crew{price ? <> · <PriceWords value={price} /></> : null}</>}
        </button>
      </div>
      {room.running && room.phase ? <span className="ag-sub" role="status">Round {room.phase.round} · {room.phase.phase}</span> : null}
      {reason ? <span className="ag-sub" data-testid="crew-reason">{reason}</span> : null}
      {room.notice ? <span className="ag-sub" role="status" data-testid="crew-notice">{room.notice}</span> : null}
      {problem ? <span className="ag-sub" role="alert">{problem}</span> : null}
      {open.map((s) => (
        <div key={s.id} className="ag-note-card" data-testid="crew-note">
          <span className="ag-eyebrow ag-eyebrow-quiet">Crew · round {s.round}</span>
          <p className="ag-text">{s.text}</p>
          <div className="ag-actions">
            <button type="button" className="ag-btn ag-btn-quiet" onClick={() => void room.dropSolution(s.id)} data-testid="crew-dismiss">Dismiss</button>
            <button type="button" className="ag-btn" onClick={() => void brief(s.id)} data-testid="crew-brief">Add to brief · free</button>
            <button type="button" className="ag-btn ag-btn-primary" onClick={() => void make(s.id)} data-testid="crew-make">Open in Make</button>
          </div>
        </div>
      ))}
    </div>
  );
}
