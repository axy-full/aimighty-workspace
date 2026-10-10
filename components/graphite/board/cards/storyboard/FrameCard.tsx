"use client";
import { useEffect, useRef, type MouseEvent } from "react";
import { usePriceTitle } from "@/components/graphite/Price";
import { priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { NotifyWhenDone } from "../../NotifyWhenDone";
import type { CardProps } from "../types";
import type { FrameData } from "../plan/derive";
import { FrameTile, frameTileHeight } from "./FrameTile";
import { linesHeight } from "./lines-model";
import { useLineDrawings } from "./use-lines";
import { useFramePoller } from "./use-frames";
import "./storyboard.css";

/** The frame card's box: the tile, and the row its line-drawing action takes (the "for the others" button is one more). */
export function frameCardHeight(width: number, aspect: string, data: Pick<FrameData, "lines">): number {
  const { lines } = data;
  return frameTileHeight(width, aspect) + linesHeight(lines) + (lines.has && !lines.running && lines.others > 0 ? 36 : 0);
}

const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * A storyboard frame on the board (README § 3.1 d): the shot's picture, name and line. While its frame renders it
 * reads the job until it lands and files it on the frame (free reads only); a frame that did not render says so
 * in the provider's words.
 *
 * Line drawings (gap screens): a frame with a picture offers "Line drawings · N cr", priced by the server before it runs. It renders
 * on the card (an indeterminate bar: no engine reports a percentage, so none is claimed) and lands as the frame's next version, v2,
 * with v1 kept; the chips pick which version the frame shows (free).
 */
export function FrameCard({ card, data, ctx, selected }: CardProps<FrameData>) {
  const seam = { scope: ctx.scope, project: ctx.project, apply: ctx.rig.apply, save: ctx.rig.save };
  const errors = useFramePoller(seam, data.shotId);
  const { lines } = data;
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const draw = useLineDrawings(seam, data.shotId, blocked, lines.has);
  const ownTitle = usePriceTitle(draw.own);
  const othersTitle = usePriceTitle(draw.others.price);
  /* A press that stopped (a refusal, a price that moved, a failed save) is said once, in the toast: the card's box is fixed. */
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (draw.problem && said.current !== draw.problem) ctx.toast(draw.problem);
    said.current = draw.problem;
    // The toast is the shell's; only a new problem says anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw.problem]);
  /* A line drawing that did not render: the provider's outcome, in its words (Nothing billed only when it confirms it), and the button becomes Retry. */
  const failure = data.genId ? errors[data.shotId] ?? null : null;
  const toldFailure = useRef<string | null>(null);
  useEffect(() => {
    if (failure && toldFailure.current !== failure) ctx.toast(`Line drawing: ${failure}`);
    toldFailure.current = failure;
    // The toast is the shell's; only a new failure says anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure]);
  const own = priceWords(draw.own);
  const verb = failure ? "Retry" : "Line drawings";
  const others = priceWords(draw.others.price);
  const pick = (genId: string) => {
    ctx.rig.apply((p) => {
      const boards = p.production?.boards;
      const f = boards?.frames[data.shotId];
      if (!boards || !f || f.selected === genId) return p;
      return { ...p, production: { ...p.production, boards: { ...boards, frames: { ...boards.frames, [data.shotId]: { ...f, selected: genId } } } } };
    });
    void ctx.rig.save();
  };
  const current = lines.versions.find((v) => v.genId === data.genId) ?? null;
  /* On the new interface's grid a frame is calm until it is selected: its line drawings offer and ⓘ Details show on the selected card, one row. */
  const idle = !lines.running && lines.versions.length <= 1;
  const showLines = Boolean(data.genId) && (lines.offer || lines.running || lines.versions.length > 1) && (!data.grid || selected || !idle);
  const details = data.grid && selected ? (
    <button type="button" className="gx-ln-btn gx-frame-details nodrag nopan" title="Details · i — The words this frame is drawn from."
      onClick={(e) => { e.stopPropagation(); ctx.openInspector(card.id); }} onDoubleClick={stop} data-testid="frame-details">ⓘ Details</button>
  ) : null;
  const linesBlock = showLines ? (
        <div className="gx-ln" data-testid="frame-lines" data-phase={lines.running ? "running" : lines.versions.length > 1 ? "done" : "idle"} onDoubleClick={stop}>
          {lines.running ? (
            <>
              <span className="gx-ln-state" role="status"><i aria-hidden="true" />Drawing the lines</span>
              <span className="gx-ln-bar" role="progressbar" aria-label="Drawing the lines" data-indeterminate=""><span /></span>
              <div className="gx-ln-row"><NotifyWhenDone ctx={ctx} className="gx-ln-btn" /></div>
            </>
          ) : lines.versions.length > 1 ? (
            <>
              <span className="gx-ln-state" data-tone="done"><i aria-hidden="true" />{current ? current.label.replace(/^v(\d+)/, "Version $1") : "Versions"}</span>
              <div className="gx-ln-row" role="group" aria-label="Versions">
                {lines.versions.map((v) => (
                  <button key={v.genId} type="button" className="gx-ln-btn gx-ln-chip nodrag nopan" aria-pressed={v.genId === data.genId}
                    onClick={(e) => { e.stopPropagation(); pick(v.genId); }} onDoubleClick={stop} data-testid="frame-version">{v.label}</button>
                ))}
              </div>
              {lines.has && lines.others > 0 ? (
                <div className="gx-ln-row">
                  <button type="button" className="gx-ln-btn nodrag nopan" title={othersTitle ?? blocked ?? undefined} aria-busy={draw.busy || undefined}
                    {...spendAttrsOf(draw.others.price)} disabled={Boolean(blocked) || draw.busy || !draw.others.price}
                    onClick={(e) => { e.stopPropagation(); void draw.send(draw.others.ids); }} onDoubleClick={stop} data-testid="frame-lines-others">
                    {others ? `Line drawings for the other ${lines.others} · ${others}` : `Line drawings for the other ${lines.others}`}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="gx-ln-row">
              <button type="button" className="gx-ln-btn nodrag nopan" data-primary={(selected && !data.grid) || undefined} title={ownTitle ?? blocked ?? (draw.pricing === "error" ? "The price could not be read." : undefined)} aria-busy={draw.busy || undefined}
                {...spendAttrsOf(draw.own)} disabled={Boolean(blocked) || draw.busy || !draw.own}
                onClick={(e) => { e.stopPropagation(); void draw.send([data.shotId]); }} onDoubleClick={stop} data-testid="frame-lines-go">
                {own ? `${verb} · ${own}` : verb}
              </button>
              {draw.pricing === "error" ? <button type="button" className="gx-ln-btn nodrag nopan" onClick={(e) => { e.stopPropagation(); draw.tryAgain(); }} onDoubleClick={stop} data-testid="frame-lines-try-again">Try again</button> : null}
            </div>
          )}
        </div>
      ) : null;
  return (
    <FrameTile name={data.name} line={data.line} genId={data.genId} aspect={ctx.project.aspect} rendering={data.rendering}
      empty={errors[data.shotId] ?? "No frame yet"} testId="board-frame"
      badge={current && lines.versions.length > 1 ? { text: `V${current.n}`, tone: "dark" } : null}>
      {data.grid ? (linesBlock || details ? <div className="gx-frame-acts" data-testid="frame-grid-actions">{linesBlock}{details}</div> : null) : linesBlock}
    </FrameTile>
  );
}
