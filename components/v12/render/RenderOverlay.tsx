"use client";
import type { RenderState } from "@/lib/v12/renderState";
import "./render.css";

/**
 * The words and motion of a take in flight, drawn over its source (redesign P3; docs/redesign/inventory.md § 7; prototype
 * L321). The card keeps its source picture, blurred and dimmed by the stylesheet; over it, in two separate places:
 *  - the field: six slow dots in the picture's upper part, where no text ever is;
 *  - the text block, on a solid scrim at the bottom: the stage, the time on ONE line (its short form; the full words are
 *    the tooltip, and the slow sentence is too), and the bar (to about 90%, never more). The money, once, is `RenderMoney`,
 *    in the card's own row under the picture.
 * Cancel is drawn only where the model says it bills nothing (a held take, one waiting in its provider's queue): never
 * on Preparing, Rendering or Saving, and Esc never reaches it. Reduced motion: still dots, no drift, no shimmer.
 */
export function RenderOverlay({ state, onCancel, cancelling = false, pending = false, gather = false }: {
  state: RenderState;
  onCancel?: () => void;
  cancelling?: boolean;
  /** A cancel was sent to the engine and is not confirmed: the take says so, and Cancel is not offered again. */
  pending?: boolean;
  /** The take has just landed: the dots gather into the frame (about 0.6 s). */
  gather?: boolean;
}) {
  const failed = state.failed;
  const cancel = state.cancel;
  return (
    <div className="v12-rc" data-testid="v12-render" data-stage={state.stage} data-tone={state.tone} data-slow={state.slow || undefined} data-gather={gather || undefined}>
      {!failed && state.stage !== "held" ? (
        <span className="v12-rc-field" aria-hidden="true" data-testid="v12-render-field"><i /><i /><i /><i /><i /><i /></span>
      ) : null}
      <div className="v12-rc-text" data-testid="v12-render-text">
        <div className="v12-rc-head">
          <span className="v12-rc-stage" data-tone={state.tone}><span className="v12-rc-dot" aria-hidden="true" /><span className="v12-rc-label" data-testid="v12-render-stage">{state.label}</span></span>
          {pending ? <span className="v12-rc-pending" title="The engine has the cancel. The take says what it cost once it answers." data-testid="v12-render-cancel-sent">Cancel sent</span>
          : cancel?.cancellable && onCancel ? (
            <button type="button" className="v12-rc-cancel nodrag nopan" onClick={(e) => { e.stopPropagation(); onCancel(); }} onDoubleClick={(e) => e.stopPropagation()}
              disabled={cancelling} title={cancel.tooltip} aria-label={`Cancel. ${cancel.tooltip}`} data-testid="v12-render-cancel">Cancel</button>
          ) : null}
        </div>
        {state.line ? <div className="v12-rc-line" title={state.line.title} data-testid="v12-render-line">{state.line.short}</div> : null}
        {state.bar ? <span className="v12-rc-bar" data-hold={state.bar.hold ? "" : undefined} role="progressbar" aria-label={state.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.bar.pct * 100)} data-testid="v12-render-bar"><span style={{ width: `${Math.round(state.bar.pct * 100)}%` }} /></span> : null}
      </div>
    </div>
  );
}

/** The money line, once ("7 cr held · charged only when it’s ready"): the figure first, so a narrow card cuts only the tail. */
export function RenderMoney({ state }: { state: RenderState }) {
  const money = state.money;
  if (!money || state.failed) return null;
  const head = money.short;
  const tail = money.text.startsWith(head) ? money.text.slice(head.length) : "";
  return (
    <div className="v12-rc-money" title={money.text} data-testid="v12-render-money"><span>{head}</span>{tail ? <span className="v12-rc-tail">{tail}</span> : null}</div>
  );
}

/** The dots gathering into the frame when a take lands (about 0.6 s); with reduced motion they are simply gone. */
export function RenderGather() {
  return (
    <div className="v12-rc" data-gather data-testid="v12-render-gather" aria-hidden="true">
      <span className="v12-rc-field"><i /><i /><i /><i /><i /><i /></span>
    </div>
  );
}
