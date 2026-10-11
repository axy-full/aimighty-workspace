"use client";
import { useMemo, useState } from "react";
import type { GuestBoard } from "@/lib/guest/board";
import { fmtCredits } from "@/lib/price";
import { currentStage, stageEmpty, stagesOf, type Stage } from "@/lib/v12/board/stages";
import { SAMPLE_PILL } from "@/lib/v12/visitor";
import { Bar } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import { StageRail } from "@/components/v12/board/StageRail";
import { StageEmpty } from "@/components/v12/board/StageEmpty";
import { useJoin } from "@/components/v12/join/JoinProvider";
import type { JoinReason } from "@/components/v12/join/join-model";

/**
 * The sample board, explorable (docs/redesign/inventory.md § 8.2): the Film rail and its stages over what Particl's own
 * sample production shows a visitor (lib/guest/sample.server.ts: words, plan, shots and cut, no media, no ids, no people),
 * under a pill that says changes are not saved. Nothing on it is kept: every action (Approve, Redraw, Download, Ask) opens
 * the join sheet. A visitor has no workspace, so no route is called here.
 */
export function VisitorBoard({ title, board }: { title: string; board: GuestBoard | null }) {
  const join = useJoin()!;
  const stages = useMemo(() => stagesOf("film", null), []);
  const [asked, setAsked] = useState<string | null>(null);
  const stage = currentStage(stages, asked, "film") as Stage;
  const gate: Gate = (reason, detail) => join.openJoin(reason, detail ? { detail } : {});
  const status = (s: Stage) => ({ state: has(board, s.id) ? "done" as const : "empty" as const, count: 0, summary: has(board, s.id) ? "On the sample" : "Nothing yet", cards: 0 });
  return (
    <div className="v12-vboard" data-testid="v12-visitor-board" data-stage={stage.id}>
      <StageRail kindLabel="Film" stages={stages} current={stage.id} status={status} readOnly="Sample" onPick={setAsked} onEdit={() => gate("approve")} />
      <div className="v12-vboard-main">
        <div className="v12-stagehead" data-testid="v12-stage-header">
          <span className="v12-stagehead-left">
            <span className="v12-crumbs">
              <button type="button" className="v12-crumb v12-crumb-board" onClick={() => setAsked(stages[0].id)}>{title}</button>
              <span className="v12-crumb-sep" aria-hidden="true">›</span>
              <span className="v12-crumb v12-crumb-stage" data-testid="v12-visitor-stage">{stage.label}</span>
            </span>
            <span className="v12-vpill" data-testid="v12-visitor-pill">{SAMPLE_PILL}</span>
          </span>
        </div>
        <div className="v12-vboard-canvas gx-scroll">
          <Stage stage={stage} board={board} gate={gate} />
        </div>
        <div className="v12-vboard-bar">
          <Bar value="" onChange={() => {}} onSubmit={() => gate("ask")} placeholder="Ask for a change, add a shot, or paste client feedback" label="Ask Atomik"
            onAttach={() => {}} onAttachPress={() => gate("upload")} attachTitle="Attach a file — Needs a Particl account."
            send={{ label: "Ask", price: <Price quote={null} reason="visitorStart" />, testId: "v12-visitor-ask-send" }} testId="v12-visitor-board-bar" />
        </div>
      </div>
    </div>
  );
}

const has = (board: GuestBoard | null, id: string): boolean => {
  if (!board) return false;
  switch (id) {
    case "brief": return Boolean(board.brief);
    case "cast": return board.cast.length > 0;
    case "storyboard": return board.shots.length > 0;
    case "shots": return Boolean(board.plan);
    case "cut": return board.cut.approved > 0 || board.cut.waiting > 0;
    case "deliver": return board.deliver.length > 0;
    default: return false;
  }
};

type Gate = (reason: JoinReason, detail?: string) => void;

function Stage({ stage, board, gate }: { stage: Stage; board: GuestBoard | null; gate: Gate }) {
  if (!board || !has(board, stage.id)) return <div className="v12-vboard-empty"><StageEmpty empty={stageEmpty(stage)} /></div>;
  switch (stage.id) {
    case "brief":
      return (
        <div className="v12-vcards">
          <Card title="What we’re making" meta={board.frame}><p className="v12-vcard-text">{board.brief}</p></Card>
        </div>
      );
    case "cast":
      return <div className="v12-vcards">{board.cast.map((line) => <Card key={line} title={line.split(" · ")[0]} meta="Cast"><p className="v12-vcard-text">{line}</p><Actions gate={gate} approve /></Card>)}</div>;
    case "storyboard":
      return (
        <div className="v12-vcards v12-vcards-shots">
          {board.shots.map((shot) => (
            <Card key={shot.index} title={`Shot ${shot.index}`} meta={`${shot.name} · ${shot.start} · ${shot.seconds} s`} state={shot.approved ? "Approved" : "Waiting"}>
              <Actions gate={gate} approve={!shot.approved} redraw />
            </Card>
          ))}
        </div>
      );
    case "shots":
      return (
        <div className="v12-vcards">
          {board.plan ? (
            <Card title={board.plan.heading} meta={`Fixes if needed · up to 2 per shot · at most ${fmtCredits(board.plan.fixesMost)}`}>
              <ul className="v12-vplan">{board.plan.steps.map((s) => <li key={s.title}><span>{s.title}</span><span className="v12-vmono">{s.meta}</span><span className="v12-vmono">{fmtCredits(s.credits)}</span></li>)}</ul>
              <div className="v12-vcard-acts"><button type="button" className="v12-vbtn v12-vbtn-primary" onClick={() => gate("price", `Approve · ${fmtCredits(board.plan!.total)}`)} data-testid="v12-visitor-plan-approve">Approve · {fmtCredits(board.plan.total)}</button></div>
            </Card>
          ) : null}
          {board.review ? <Card title={board.review.name} meta={board.review.meta ?? "Waits for review"}><Actions gate={gate} approve /></Card> : null}
        </div>
      );
    case "cut":
      return <div className="v12-vcards"><Card title={`Cut · ${board.cut.seconds}`} meta={board.cut.line}><div className="v12-vcard-acts"><button type="button" className="v12-vbtn" onClick={() => gate("download")}>Download</button></div></Card></div>;
    case "deliver":
      return <div className="v12-vcards"><Card title="Delivery" meta="Spec check">{board.deliver.map((d) => <p key={d.label} className="v12-vcard-text"><span className="v12-vmono">{d.label}</span> {d.value}</p>)}<div className="v12-vcard-acts"><button type="button" className="v12-vbtn" onClick={() => gate("download")}>Download</button></div></Card></div>;
    default:
      return <div className="v12-vboard-empty"><StageEmpty empty={stageEmpty(stage)} /></div>;
  }
}

function Card({ title, meta, state, children }: { title: string; meta?: string; state?: string; children?: React.ReactNode }) {
  return (
    <article className="v12-vcard" data-testid="v12-visitor-card">
      <header className="v12-vcard-head"><h3 className="v12-vcard-title">{title}</h3>{state ? <span className="v12-vcard-state">{state}</span> : null}</header>
      {meta ? <p className="v12-vcard-meta">{meta}</p> : null}
      {children}
    </article>
  );
}

function Actions({ gate, approve, redraw }: { gate: Gate; approve?: boolean; redraw?: boolean }) {
  return (
    <div className="v12-vcard-acts">
      {approve ? <button type="button" className="v12-vbtn" onClick={() => gate("approve")} data-testid="v12-visitor-approve">Approve</button> : null}
      {redraw ? <button type="button" className="v12-vbtn" onClick={() => gate("approve")} data-testid="v12-visitor-redraw">Redraw</button> : null}
    </div>
  );
}
