"use client";
import { useState } from "react";
import { usePriceTitle } from "@/components/graphite/Price";
import { priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { TranscriptionSource } from "@/lib/workbench/transcription-request";
import type { BoardCtx } from "../cards/types";
import { clock } from "./transcript-model";
import { openTranscript } from "./transcript-panel-store";
import { useTranscribe } from "./use-transcribe";
import "./transcribe.css";

/** The row a card with a video or audio source reserves for this action (its button, its running state or its failure). */
export const TRANSCRIBE_ROW = 84;

/** A browser notification when this card's own press finishes, if the person asked for one and the browser lets it. */
function useNotifyWhenDone(ctx: BoardCtx, name: string) {
  const [on, setOn] = useState(false);
  const ask = async () => {
    if (typeof Notification === "undefined") { ctx.toast("Notifications are not supported in this browser."); return; }
    if (Notification.permission === "denied") { ctx.toast("Notifications are blocked in the browser."); return; }
    const answer = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (answer !== "granted") { ctx.toast("Notifications were not allowed."); return; }
    setOn(true);
    ctx.toast("You'll be told when it's done, while Particl is open.");
  };
  const tell = () => {
    if (!on || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification("Transcript ready", { body: name }); } catch { /* the page is told in its own way */ }
  };
  return { on, ask, tell };
}

/**
 * Transcribe on a video or audio card (gap screens): the price before it runs (the server's own quote for this source's length),
 * running with the time so far and Notify me when done, done with the transcript's lines and Open transcript, or failed with
 * "Nothing billed" only when the server says it charged nothing, and Retry carrying the price. Only a person's press sends it,
 * and Atomik never presses it.
 */
export function TranscribeAction({ ctx, source, name }: { ctx: BoardCtx; source: TranscriptionSource; name: string }) {
  const notify = useNotifyWhenDone(ctx, name);
  const t = useTranscribe({ scope: ctx.scope, source, projectId: ctx.project.productionProjectId ?? null, name, onDone: () => notify.tell() });
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const words = priceWords(t.price);
  const title = usePriceTitle(t.price);
  const stop = { onDoubleClick: (e: { stopPropagation: () => void }) => e.stopPropagation() };

  if (t.phase === "done" && t.saved) {
    return (
      <div className="gx-tr" data-testid="transcribe-done" data-phase="done" {...stop}>
        <span className="gx-tr-state" data-tone="done"><i aria-hidden="true" />Transcript · {t.saved.lines.length} {t.saved.lines.length === 1 ? "line" : "lines"}</span>
        <div className="gx-tr-row">
          <button type="button" className="gx-tr-btn nodrag nopan" onClick={(e) => { e.stopPropagation(); openTranscript({ slot: t.slot, name }); }} data-testid="transcribe-open">Open transcript</button>
        </div>
      </div>
    );
  }
  if (t.phase === "running") {
    return (
      <div className="gx-tr" data-testid="transcribe-running" data-phase="running" {...stop}>
        <span className="gx-tr-state" role="status"><i aria-hidden="true" />Transcribing · {clock(t.elapsed)}</span>
        <span className="gx-tr-bar" role="progressbar" aria-label="Transcribing" data-indeterminate=""><span /></span>
        <div className="gx-tr-row">
          <button type="button" className="gx-tr-btn nodrag nopan" aria-pressed={notify.on} onClick={(e) => { e.stopPropagation(); void notify.ask(); }} data-testid="transcribe-notify">Notify me when done</button>
        </div>
      </div>
    );
  }
  if (t.phase === "checking") {
    return (
      <div className="gx-tr" data-testid="transcribe-checking" data-phase="checking" {...stop}>
        <span className="gx-tr-state" role="status"><i aria-hidden="true" />Checking your last transcription</span>
        <div className="gx-tr-row">
          <span className="gx-tr-why">{t.note || "Nothing is sent again."}</span>
          {t.checkFailed ? <button type="button" className="gx-tr-btn nodrag nopan" onClick={(e) => { e.stopPropagation(); t.check(); }} data-testid="transcribe-check">Try again</button> : null}
        </div>
      </div>
    );
  }
  const failed = t.phase === "failed";
  const nothingBilled = failed && t.charged === 0;
  return (
    <div className="gx-tr" data-testid="transcribe-action" data-phase={failed ? "failed" : "idle"} {...stop}>
      {failed ? (
        <span className="gx-tr-state" data-tone="failed" role="alert"><i aria-hidden="true" />Transcription failed{nothingBilled ? " · Nothing billed" : ""}</span>
      ) : null}
      {failed && !nothingBilled ? <span className="gx-tr-why" data-testid="transcribe-why">{t.error}</span> : null}
      <div className="gx-tr-row">
        <button type="button" className="gx-tr-btn nodrag nopan" title={title ?? blocked ?? undefined} {...spendAttrsOf(t.price)}
          disabled={Boolean(blocked) || !t.price} onClick={(e) => { e.stopPropagation(); t.run(); }} data-testid="transcribe-go">
          {words ? `${failed ? "Retry" : "Transcribe"} · ${words}` : failed ? "Retry" : "Transcribe"}
        </button>
        {t.pricing === "error" ? <button type="button" className="gx-tr-btn nodrag nopan" onClick={(e) => { e.stopPropagation(); t.tryAgain(); }} data-testid="transcribe-try-again">Try again</button> : null}
      </div>
    </div>
  );
}
