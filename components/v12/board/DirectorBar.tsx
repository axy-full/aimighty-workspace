"use client";
import type { ReactNode } from "react";
import { spendAttrsOf } from "@/lib/spend";
import { Price } from "../ui/Price";
import { knownQuote } from "@/lib/v12/quote";
import { useEffect } from "react";
import { NOTHING_LEFT_NOTE, NO_ENGINE_NOTE, PRESS_LIMIT_NOTE, PRESS_MAX_SHOTS, barButton, failureNote, nextStepLabel, type Scope } from "./director-model";
import { useDirectorRender, type DirectorRender, type DirectorShot } from "./use-director-render";
import "./director.css";

/**
 * Director mode's bar on Shots (v25 PR 7): the scope pill ("All 8 shots", "Shot 4": the same words as the column's header and the button), then the
 * bar. The bar holds the ask (the board's own, handed in as `ask`) and ONE filled button, the screen's only one:
 *
 *   idle     "Render 8 shots · 344 cr"   the server's price for the whole press (one job, one approval for the total, #815); a press is the approval of that figure,
 *                                        and a press the workspace's monthly cap would not cover is refused at the quote: its words show and the button is off
 *   making   "Making…"                   disabled, with "3 of 8 ready"; "Cancel" beside it only while a take is still queued at the provider
 *   done     "Next: Edit →"              the way on; not a spend, so no price
 *
 * A price that is not yet read leaves the button disabled with the last one shown. Until an engine is picked (`engine` null: Director never picks one,
 * owner 16 Oct 2026, 2a) nothing is priced and the button is off; so too past PRESS_MAX_SHOTS shots, where the line says "Up to 24 shots at a time. Pick some."
 * (owner, 21 Oct 2026). Everything it says in words comes from director-model.ts.
 *
 * After the takes settle, a take that failed at no charge is offered Retry under the press's approval, priced at the shots still to start; one that failed and
 * was charged is offered "Render again · N cr", a new press of those shots alone, and its line keeps what it cost (owner, 21 Oct 2026).
 */
const NONE: readonly DirectorShot[] = [];

export function DirectorBar({ scope, scopeKey, projectKey, shots, engine = null, stages, step, readOnly, ask, onState, onNext, onTopUp }: {
  scope: Scope;
  /** The request scope (the signed-in person's workspace), as every paid send carries it. */
  scopeKey: string;
  projectKey: string;
  /** Exactly the requests a press will send, one per shot in the scope (the board builds them from its shots' settings). */
  shots: readonly DirectorShot[];
  /** The engine the person picked for the step (its id), or null: nothing is priced or sent until there is one. */
  engine?: string | null;
  /** The board's stages and the open one: "Next: …" is the stage after it that is not skipped. */
  stages: readonly { id: string; label: string; skipped: boolean }[];
  step: string;
  /** Why nothing can be sent here (the sample, an offline board): the button is off and says so. */
  readOnly?: string | null;
  /** The board's ask: Attach, @, the words and Ask. */
  ask?: ReactNode;
  /** The bar's state and progress as they change, for the cards ("Making…") and the column. */
  onState?: (render: Pick<DirectorRender, "state" | "finished" | "total">) => void;
  /** After "Next: …" is pressed: the board opens the next step. */
  onNext?: (nextLabel: string | null) => void;
  /**
   * Top up, offered when the server says the balance is short of the press (402). The board passes today's path, as the account menu does
   * (components/v12/shell/AccountMenu.tsx: `useGoSettings()("credits", "packs")`, Settings › Credits & billing); with none, the words alone are shown.
   */
  onTopUp?: () => void;
}) {
  /* More shots than a press takes: nothing is priced or sent, and the line asks for a pick (the plan's own words). */
  const over = shots.length > PRESS_MAX_SHOTS;
  const render = useDirectorRender({ scope: scopeKey, projectKey, shots: engine && !over ? shots : NONE, readOnly: readOnly ?? (!engine ? NO_ENGINE_NOTE : over ? PRESS_LIMIT_NOTE : null) });
  const next = nextStepLabel(stages, step);
  useEffect(() => { onState?.({ state: render.state, finished: render.finished, total: render.total }); }, [onState, render.state, render.finished, render.total]);
  const { state, price, pricing, problem, canCancel, failures, retry, short, renderAgain, carried } = render;
  const progress = { finished: render.finished, total: render.total };
  const onRender = () => void render.press();
  const onCancel = () => void render.cancel();
  const onTryAgain = render.tryAgain;
  const goNext = () => { onNext?.(next); render.reset(); };
  const label = barButton({ state, scope, next });
  const making = state === "sending" || state === "making";
  const priced = state === "idle" && price !== null;
  const off = readOnly != null || !engine || over || (state === "idle" && (pricing !== "ready" || !scope.ids.length));
  /* Refused at the quote (the workspace's monthly cap, owner 19 Oct 2026): the server's own words, and Render stays off. */
  const unpriced = state === "idle" && (pricing === "error" || pricing === "refused");
  /* After every take settled: what failed or was cancelled, in the take's own failure line (what happened, what it cost). */
  const failed = state === "done" ? failureNote(failures) : null;
  /* What the takes a Render again is for cost, the press's own words (shots that did not start) and the takes that failed, side by side. */
  const said = [carried, problem, failed].filter(Boolean).join(" ") || null;
  const note = said ?? (state === "idle" && render.nothingToStart ? NOTHING_LEFT_NOTE : null) ?? (state === "idle" && pricing === "refused" ? render.refusal : state === "idle" && pricing === "error" ? "A price could not be read. Nothing was sent." : null) ?? readOnly
    ?? (!engine ? NO_ENGINE_NOTE : over ? PRESS_LIMIT_NOTE : null);
  /* Retry asks the press again under the approval it was pressed with, priced at what it can still start (director-model.ts retryPrice). */
  const again = retry ? render.retryPrice : null;
  /* Render again is a new press, so it shows its own price, or the server's words when it would not take it. */
  const anew = renderAgain?.price ? renderAgain : null;
  const anewRefused = !anew && renderAgain?.refusal ? renderAgain.refusal : null;
  /* One button for one ask (rule 13): while Retry is on offer with nothing making, it takes Render's place; while takes are making or settled, it sits in the line. */
  const retryInBar = Boolean(retry && again && state === "idle");
  return (
    <div className="v12-dirbar" data-testid="v12-director-bar" data-state={state}>
      <span className="v12-dirbar-pill" data-testid="v12-director-scope">{scope.label}</span>
      {note || anew || anewRefused ? <p className="v12-dirbar-note" role="status" data-testid="v12-director-note">{note}
        {unpriced && !problem && onTryAgain ? <> <button type="button" className="v12-dirbar-link" onClick={onTryAgain} data-testid="v12-director-try-again">Try again</button></> : null}
        {retry && again && !retryInBar ? <> <button type="button" className="v12-dirbar-link" onClick={retry} data-testid="v12-director-retry" {...spendAttrsOf(again)}>Retry · <Price quote={knownQuote(again)} /></button></> : null}
        {anew ? <> <button type="button" className="v12-dirbar-link" onClick={anew.run} data-testid="v12-director-render-again" {...spendAttrsOf(anew.price)}>Render again · <Price quote={knownQuote(anew.price)} /></button></> : null}
        {anewRefused ? <> <span data-testid="v12-director-render-again-refused">{anewRefused}</span></> : null}
        {state === "idle" && render.startOver ? <> <button type="button" className="v12-dirbar-link" onClick={render.startOver} data-testid="v12-director-start-over">Start over</button></> : null}
        {short && onTopUp ? <> <button type="button" className="v12-dirbar-link" onClick={onTopUp} data-testid="v12-director-top-up">Top up</button></> : null}
      </p> : null}
      <div className="v12-dirbar-row">
        {ask ? <div className="v12-dirbar-ask">{ask}</div> : null}
        {state === "making" && canCancel ? <button type="button" className="v12-dirbar-cancel" onClick={onCancel} data-testid="v12-director-cancel">Cancel</button> : null}
        {retryInBar ? (
          <button type="button" className="v12-dirbar-go" onClick={retry!} data-testid="v12-director-go" data-retry="" {...spendAttrsOf(again)}>Retry · <Price quote={knownQuote(again)} /></button>
        ) : state === "done" ? (
          <button type="button" className="v12-dirbar-go" onClick={goNext} data-testid="v12-director-go">{label}</button>
        ) : (
          <button type="button" className="v12-dirbar-go" disabled={making || off} aria-busy={making || undefined} onClick={onRender} data-testid="v12-director-go"
            {...(state === "idle" ? spendAttrsOf(price) : {})}>
            {label}{priced ? <> · <Price quote={knownQuote(price)} /></> : null}{making && progress && progress.total ? <span className="v12-dirbar-progress"> · {progress.finished} of {progress.total}</span> : null}
          </button>
        )}
      </div>
    </div>
  );
}
