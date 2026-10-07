"use client";
import { useMemo, useState } from "react";
/* The shot on screen stays on screen once it is judged: it no longer waits for a person, and the panel must not jump to another. */
import { useProjectLibrary } from "@/lib/workspace/library";
import { useSession } from "@/lib/session";
import { RejectPanel } from "../cards/take/RejectPanel";
import { shotTakes } from "../cards/take/take-model";
import { postTakeNote, useJudge } from "../cards/take/use-judge";
import { useTakeNotes } from "../cards/take/use-take-notes";
import type { BoardCtx } from "../cards/types";
import { NOTE_MAX, earlierTakes, noteProblem, noteTime, panelShot, panelSub, panelVersion, reviewable, reviewersOf } from "./crew-model";
import { CrewClientSeam } from "./crew-seam";
import "../cards/take/take.css";

/*
 * Crew review, the internal part (Gaps A frames, "Crew review"): the notes the team has on a take, Approve, and Reject with a
 * reason (the reasons as chips and a free line, the board's own RejectPanel). Every action here is free and a signed-in person's:
 * approving and rejecting go through the review trail the take cards use (use-judge), and a note is a team note
 * (POST /api/notes). Nothing is made or spent. It sits at the top of the Crew review panel, above Ask the crew.
 *
 * The client's side (the client link, and the client's own view) is another part of the panel: CrewClientSeam, below. It
 * renders whatever the security work registers there (components/graphite/board/review/crew-seam.ts) and nothing before then.
 */
export function CrewTakeReview({ ctx }: { ctx: BoardCtx }) {
  const { signedIn } = useSession();
  const library = useProjectLibrary(ctx.scope, ctx.project.id);
  const rows = useMemo(() => shotTakes(ctx.project, library.items), [ctx.project, library.items]);
  const shots = reviewable(rows);
  const judge = useJudge(ctx.scope, ctx.project.id, ctx.toast);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const row = panelShot(rows, nodeId);
  const version = row ? panelVersion(row, picked) : null;
  const notes = useTakeNotes(ctx.scope, row ? row.versions.map((v) => v.genId) : []);
  if (!row || !version) return <p className="ag-sub" data-testid="crew-take-none">No take to review yet. Takes appear here once they have rendered.</p>;
  const mine = notes.get(version.genId) ?? [];
  const reviewers = reviewersOf(mine);
  const act = signedIn && !ctx.offline;
  const why = ctx.offline ? "Needs a connection" : undefined;
  const earlier = earlierTakes(row, version, notes);
  const send = async () => {
    const problem = noteProblem(note);
    if (problem) { setHint(problem); return; }
    setHint(null); setSaving(true);
    try { await postTakeNote(ctx.scope, version.genId, note.trim()); setNote(""); }
    catch (cause) { setHint(cause instanceof Error ? cause.message : "The note was not saved."); }
    finally { setSaving(false); }
  };
  const pick = (id: string) => { setNodeId(id); setPicked(null); setRejecting(false); setHint(null); };
  return (
    <div className="ag-msg ag-crew-take" data-testid="crew-take">
      <div className="ag-row"><span className="ag-title">Crew review</span><span className="ag-sub" data-testid="crew-take-sub">{panelSub(row, version, reviewers)}</span></div>
      {shots.length > 1 ? (
        <div className="ag-chips" role="group" aria-label="Shot to review">
          {shots.map((r) => <button key={r.nodeId} type="button" className="ag-chip" aria-pressed={r.nodeId === row.nodeId} onClick={() => pick(r.nodeId)} data-testid="crew-take-shot">Shot {r.index}</button>)}
        </div>
      ) : null}
      {row.versions.filter((v) => v.status !== "failed").length > 1 ? (
        <div className="ag-chips" role="group" aria-label="Version">
          {row.versions.filter((v) => panelVersion(row, v.genId)?.genId === v.genId).map((v) => <button key={v.genId} type="button" className="ag-chip" aria-pressed={v.genId === version.genId} onClick={() => { setPicked(v.genId); setRejecting(false); }} data-testid="crew-take-version">{v.label}</button>)}
        </div>
      ) : null}
      {reviewers.length ? (
        <div className="ag-chips" role="list" aria-label="Reviewers">
          {reviewers.map((r) => <span key={`${r.client}:${r.name}`} role="listitem" className="ag-chip ag-chip-who" data-client={r.client || undefined} data-testid="crew-take-reviewer">{r.name}</span>)}
        </div>
      ) : null}

      <span className="ag-eyebrow ag-eyebrow-quiet">Notes on Shot {row.index} · {version.label}</span>
      {mine.length ? (
        <ul className="ag-notes" data-testid="crew-take-notes">
          {mine.map((n, i) => (
            <li key={`${n.at}:${i}`} className="ag-note-row" data-client={n.guest || undefined}>
              <span className="ag-note-who">{n.guest ? "Client · via link" : n.author}<time>{noteTime(n.at)}</time></span>
              <span className="ag-note-text">{n.text}</span>
            </li>
          ))}
        </ul>
      ) : <p className="ag-sub" data-testid="crew-take-nonotes">No notes on this take yet.</p>}
      {act ? (
        <form className="ag-note-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea rows={2} maxLength={NOTE_MAX} value={note} placeholder="Add a note for the team" aria-label="Add a note on this take" onChange={(e) => { setNote(e.target.value); setHint(null); }} data-testid="crew-take-note-input" />
          <button type="submit" className="ag-btn" disabled={saving || !note.trim()} data-testid="crew-take-note-add">Add note · free</button>
        </form>
      ) : null}
      {hint ? <span className="ag-sub" role="alert" data-testid="crew-take-hint">{hint}</span> : null}

      {earlier.length ? (
        <>
          <span className="ag-eyebrow ag-eyebrow-quiet">Earlier takes</span>
          <ul className="ag-notes" data-testid="crew-take-earlier">{earlier.map((e) => <li key={e.key} className="ag-dec"><span>{e.label}</span><span className="ag-sub">{e.said}</span></li>)}</ul>
        </>
      ) : null}

      {rejecting ? (
        <RejectPanel busy={Boolean(judge.busy)} onCancel={() => setRejecting(false)} onReject={(reason) => { setNodeId(row.nodeId); setPicked(version.genId); void judge.reject(row, version, reason).then((ok) => { if (ok) setRejecting(false); }); }} />
      ) : (
        <div className="ag-actions" data-testid="crew-take-decide">
          <button type="button" className="ag-btn ag-btn-primary" disabled={!act || version.status === "approved" || Boolean(judge.busy)} title={why}
            onClick={() => { setNodeId(row.nodeId); setPicked(version.genId); void judge.approve(row, version); }} data-testid="crew-take-approve">{version.status === "approved" ? `Shot ${row.index} approved` : `Approve Shot ${row.index}`}</button>
          <button type="button" className="ag-btn" disabled={!act || version.status === "changes" || Boolean(judge.busy)} title={why} onClick={() => setRejecting(true)} data-testid="crew-take-reject">{version.status === "changes" ? "Rejected" : "Reject with a reason"}</button>
        </div>
      )}
      <CrewClientSeam ctx={ctx} />
    </div>
  );
}
