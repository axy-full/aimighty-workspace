"use client";
import type { ReactNode } from "react";
import { spendAttrsOf } from "@/lib/spend";
import type { PriceValue } from "@/lib/shell/price-words";
import { Price } from "../ui/Price";
import { knownQuote } from "@/lib/v12/quote";
import { barButton, type BarState, type Scope } from "./director-model";
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
export function DirectorBar({ scope, state, price, pricing, next, progress, problem, canCancel, readOnly, ask, onRender, onCancel, onNext, onTryAgain }: {
  scope: Scope;
  state: BarState;
  price: PriceValue | null;
  pricing: "none" | "loading" | "ready" | "error";
  next: string | null;
  progress?: { finished: number; total: number };
  problem?: string | null;
  canCancel?: boolean;
  /** Why nothing can be sent here (the sample, an offline board): the button is off and says so. */
  readOnly?: string | null;
  /** The board's ask: Attach, @, the words and Ask. */
  ask?: ReactNode;
  onRender: () => void;
  onCancel: () => void;
  onNext: () => void;
  onTryAgain?: () => void;
}) {
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
          <button type="button" className="v12-dirbar-go" onClick={onNext} data-testid="v12-director-go">{label}</button>
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
