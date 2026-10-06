"use client";
import type { GuestBoard } from "@/lib/guest/board";

/**
 * The sample production, read-only, for a guest (Guest Home frame 2 / P2; README § 3.7).
 *
 * With the sample in the "Particl sample" workspace (`board`, read by lib/guest/sample.server.ts through stream 12's
 * reader): the brief, the plan at the credits the ledger recorded (every shot line, the total, "at most" twice the
 * total), the shots with their review state, the cast in the owner's words, and the cut with its delivery checks
 * ("pending" until every shot is approved). Without it, the frame's layout with empty slots and no media, figures or
 * names: nothing is faked. Media follows stream 12's media route (decision 38).
 *
 * Read-only means read-only (decision 39 f): every action that thinks, spends or changes work — Approve, Reject, Hold,
 * Change, Lock as master, Measure loudness, Render master, Open Edit & Sound — is either absent here or reads "Sign up
 * to make this" and opens the sheet. Nothing else is pressable.
 */
const REGIONS: { id: string; title: string; slots: number; wide?: boolean }[] = [
  { id: "looks", title: "Looks", slots: 4 },
  { id: "storyboard", title: "Storyboard", slots: 3 },
  { id: "shots", title: "Shots", slots: 3 },
  { id: "cast", title: "Cast, environment and elements", slots: 3 },
  { id: "cut", title: "Cut and deliver", slots: 1, wide: true },
];

function Gated({ onSignup, testid }: { onSignup: () => void; testid?: string }) {
  return <button type="button" className="gx-gs-gated" onClick={onSignup} data-testid={testid}>Sign up to make this</button>;
}

function Board({ title, board, onSignup }: { title: string; board: GuestBoard; onSignup: () => void }) {
  const approved = board.shots.filter((s) => s.approved).length;
  return (
    <>
      <section className="gx-gs-brief" aria-labelledby="gx-gs-title">
        <p className="gx-hm-eyebrow">Brief</p>
        <h1 className="gx-gs-title" id="gx-gs-title" data-testid="guest-sample-title">{title}</h1>
        {board.brief ? <p className="gx-gs-text" data-testid="guest-sample-brief">{board.brief}</p> : null}
        {board.frame ? <p className="gx-gs-frame">{board.frame}</p> : null}
      </section>
      {board.plan ? (
        <section className="gx-gs-group" aria-label="Plan" data-region="plan" data-testid="guest-sample-plan">
          <h2 className="gx-gs-group-h">Plan</h2>
          <div className="gx-gs-plan gx-gs-plan--card">
            <div className="gx-gs-plan-top">
              <span className="gx-gs-plan-h" data-testid="guest-plan-heading">{board.plan.heading}</span>
              <Gated onSignup={onSignup} testid="guest-sample-make" />
            </div>
            <p className="gx-gs-note" data-testid="guest-plan-fixes">Fixes if needed: up to 2 per shot, at most {board.plan.fixesMost.toLocaleString("en-US")} cr</p>
            <ul className="gx-gs-steps">
              {board.plan.steps.map((step) => (
                <li key={step.title} className="gx-gs-step" data-testid="guest-plan-step">
                  <span className="gx-gs-step-name">{step.title} · {step.meta}</span>
                  <span className="gx-gs-step-price gx-mono">{step.credits.toLocaleString("en-US")} cr</span>
                </li>
              ))}
            </ul>
            {board.plan.unpriced.length ? <p className="gx-gs-note">{board.plan.unpriced.join(", ")} not priced yet.</p> : null}
          </div>
        </section>
      ) : null}
      {board.shots.length ? (
        <section className="gx-gs-group" aria-label="Shots" data-region="shots">
          <h2 className="gx-gs-group-h" data-testid="guest-shots-heading">Shots · {approved} of {board.shots.length} approved</h2>
          <div className="gx-gs-slots">
            {board.shots.map((shot) => (
              <div key={shot.index} className="gx-gs-shot" data-state={shot.approved ? "approved" : "waiting"} data-testid="guest-shot">
                <span className="gx-gs-slot" aria-hidden="true" />
                <span className="gx-gs-shot-name">{shot.name}</span>
                <span className="gx-gs-shot-meta">{shot.start} · {shot.seconds} s · {shot.approved ? "approved" : "needs review"}</span>
              </div>
            ))}
          </div>
          {board.review ? (
            <div className="gx-gs-plan gx-gs-plan--card" data-testid="guest-review">
              <div className="gx-gs-plan-top">
                <span className="gx-gs-plan-h">{board.review.name} · review</span>
                <Gated onSignup={onSignup} testid="guest-review-gated" />
              </div>
              <p className="gx-gs-note">needs review{board.review.meta ? ` · ${board.review.meta}` : ""}</p>
            </div>
          ) : null}
        </section>
      ) : null}
      {board.cast.length ? (
        <section className="gx-gs-group" aria-label="Cast, environment and elements" data-region="cast">
          <h2 className="gx-gs-group-h">Cast, environment and elements</h2>
          <ul className="gx-gs-steps">
            {board.cast.map((line) => <li key={line} className="gx-gs-step" data-testid="guest-cast"><span className="gx-gs-step-name">{line}</span></li>)}
          </ul>
        </section>
      ) : null}
      {board.shots.length ? (
        <section className="gx-gs-group" aria-label="Cut and deliver" data-region="cut">
          <h2 className="gx-gs-group-h">Cut and deliver</h2>
          {board.cut.line ? <p className="gx-gs-text" data-testid="guest-cut-line">{board.cut.line}</p> : null}
          <dl className="gx-gs-checks" data-testid="guest-deliver">
            {board.deliver.map((d) => (
              <div key={d.label} className="gx-gs-check">
                <dt>{d.label}</dt>
                <dd>{d.value}{d.pending ? <span className="gx-gs-pending"> · pending</span> : null}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
}

export function GuestSample({ title, board, onSignup }: { title: string; board: GuestBoard | null; onSignup: () => void }) {
  return (
    <div className="gx-gs gx-scroll" data-testid="guest-sample" data-board={board ? "sample" : "empty"}>
      <p className="gx-gs-line">A sample production. <button type="button" className="gx-gs-link" onClick={onSignup} data-testid="guest-sample-signup">Sign up</button> to make your own.</p>
      <div className="gx-gs-col">
        {board ? <Board title={title} board={board} onSignup={onSignup} /> : (
          <>
            <section className="gx-gs-brief" aria-labelledby="gx-gs-title">
              <p className="gx-hm-eyebrow">Brief</p>
              <h1 className="gx-gs-title" id="gx-gs-title" data-testid="guest-sample-title">{title}</h1>
              <p className="gx-gs-wait">The looks, storyboard, plan, shots and cut appear here once the sample is made.</p>
            </section>
            {REGIONS.map((r) => (
              <section key={r.id} className="gx-gs-group" aria-label={r.title} data-region={r.id}>
                <h2 className="gx-gs-group-h">{r.title}</h2>
                <div className="gx-gs-slots" data-wide={r.wide ? "" : undefined}>
                  {Array.from({ length: r.slots }, (_, i) => <span key={i} className="gx-gs-slot" aria-hidden="true" />)}
                </div>
                {r.id === "storyboard" ? (
                  <div className="gx-gs-plan">
                    <span className="gx-gs-plan-h">The plan</span>
                    <Gated onSignup={onSignup} testid="guest-sample-make" />
                  </div>
                ) : null}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
