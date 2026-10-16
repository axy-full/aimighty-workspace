"use client";
import type { ReactNode } from "react";
import { spendAttrsOf } from "@/lib/spend";
import { Price } from "../ui/Price";
import { knownQuote } from "@/lib/v12/quote";
import { useEffect } from "react";
import { barButton, nextStepLabel, type Scope } from "./director-model";
import { useDirectorRender, type DirectorRender, type DirectorShot } from "./use-director-render";
import "./director.css";

/**
 * Director mode's bar on Shots (v25 PR 7): the scope pill ("All 8 shots", "Shot 4": the same words as the column's header and the button), then the
 * bar. The bar holds the ask (the board's own, handed in as `ask`) and ONE filled button, the screen's only one:
 *
 *   idle     "Render 8 shots · 344 cr"   the server's price for exactly what will be sent; a press is the approval of that figure
 *   making   "Making…"                   disabled, with "3 of 8 ready"; "Cancel" beside it only while a take is still queued at the provider
 *   done     "Next: Edit →"              the way on; not a spend, so no price
 *
 * A price that is not yet read leaves the button disabled with the last one shown. Everything it says in words comes from director-model.ts.
 */
export function DirectorBar({ scope, scopeKey, projectKey, shots, stages, step, readOnly, ask, onState, onNext }: {
  scope: Scope;
  /** The request scope (the signed-in person's workspace), as every paid send carries it. */
  scopeKey: string;
  projectKey: string;
  /** Exactly the requests a press will send, one per shot in the scope (the board builds them from its shots' settings). */
  shots: readonly DirectorShot[];
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
}) {
  const render = useDirectorRender({ scope: scopeKey, projectKey, shots, readOnly });
  const next = nextStepLabel(stages, step);
  useEffect(() => { onState?.({ state: render.state, finished: render.finished, total: render.total }); }, [onState, render.state, render.finished, render.total]);
  const { state, price, pricing, problem, canCancel } = render;
  const progress = { finished: render.finished, total: render.total };
  const onRender = () => void render.press();
  const onCancel = () => void render.cancel();
  const onTryAgain = render.tryAgain;
  const goNext = () => { onNext?.(next); render.reset(); };
  const label = barButton({ state, scope, next });
  const making = state === "sending" || state === "making";
  const priced = state === "idle" && price !== null;
  const off = readOnly != null || (state === "idle" && (pricing !== "ready" || !scope.ids.length));
  const note = problem ?? (pricing === "error" && state === "idle" ? "A price could not be read. Nothing was sent." : readOnly ?? null);
  return (
    <div className="v12-dirbar" data-testid="v12-director-bar" data-state={state}>
      <span className="v12-dirbar-pill" data-testid="v12-director-scope">{scope.label}</span>
      {note ? <p className="v12-dirbar-note" role="status" data-testid="v12-director-note">{note}{pricing === "error" && state === "idle" && onTryAgain ? <> <button type="button" className="v12-dirbar-link" onClick={onTryAgain}>Try again</button></> : null}</p> : null}
      <div className="v12-dirbar-row">
        {ask ? <div className="v12-dirbar-ask">{ask}</div> : null}
        {state === "making" && canCancel ? <button type="button" className="v12-dirbar-cancel" onClick={onCancel} data-testid="v12-director-cancel">Cancel</button> : null}
        {state === "done" ? (
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
