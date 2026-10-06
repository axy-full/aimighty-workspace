"use client";
import { usePriceTitle } from "@/components/graphite/Price";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { useStoryboardDraw } from "./use-frames";
import "./storyboard.css";

/**
 * **Draw the storyboard · N cr** (lead decision 28), the docked panel's primary action once a look is picked: every
 * shot with no frame, each priced by the server and sent by one person's press at the price shown (stopping at the
 * first refusal or price that moved). The button says nothing it cannot back: no price while one is unread, and
 * "Try again" when a quote could not be read.
 */
export function DrawStoryboard({ readOnly = null, onDrawn }: { readOnly?: string | null; onDrawn?: (count: number) => void }) {
  const rig = useRig();
  const draw = useStoryboardDraw({ scope: rig.scope, project: rig.project, apply: rig.apply, save: rig.save }, readOnly);
  const title = usePriceTitle(draw.price);
  if (!rig.project || !draw.count) return null;
  const words = draw.price ? priceWords(draw.price) : null;
  const blocked = readOnly ?? draw.blocked;
  return (
    <div className="gx-draw" data-testid="board-draw">
      {draw.pricing === "error" ? (
        <button type="button" className="gx-draw-btn" data-quiet="" onClick={draw.tryAgain} data-testid="board-draw-try-again">Try again</button>
      ) : (
        <button type="button" className="gx-draw-btn" title={title ?? undefined} disabled={Boolean(blocked) || !words || draw.busy} aria-busy={draw.busy || undefined}
          onClick={() => { void draw.draw().then((n) => { if (n) onDrawn?.(n); }); }} data-testid="board-draw-button" {...spendAttrsOf(draw.price)}>
          {draw.busy ? "Sending frames…" : words ? `Draw the storyboard · ${words}` : "Draw the storyboard"}
        </button>
      )}
      {draw.problem ? <span className="gx-draw-why" role="alert">{draw.problem}</span> : blocked && !draw.busy ? <span className="gx-draw-why" role="status">{blocked}</span> : null}
      {draw.pricing === "error" ? <span className="gx-draw-why" role="status">The price could not be read.</span> : null}
    </div>
  );
}
