"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "../ui";
import { railGeometry, railState, railTip } from "./rail-model";
import "./rail.css";

/** One step on the rail. `icon` is a 16 x 16 outline path (rail-icons.ts). */
export type RailStep = {
  id: string;
  label: string;
  icon: string;
  done?: boolean;
  /** Said under the current step and in every step's tooltip: "3 of 8 ready · 1 in work", "Not started". */
  status: string;
  /** A step a board may skip (Treatment, Pitch deck): its tooltip says so. */
  optional?: boolean;
};

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The v25 stepper rail (design/particl-prototype-25 "Particl board.dc.html", README "V24 · A · Look" 2): a floating panel 16 px from the canvas's left edge,
 * vertically centred, hugging its steps and growing from the centre when one is added. Circles joined by a thin line, an icon in each, a ✓ badge when the
 * step is done, a blue ring and a status line (two lines at most) for the current step, muted when not started; the others' status is in their tooltip.
 * Spacing tightens, then the circles shrink to 26 px, before the list scrolls, with fades where more is hidden; the current step is kept in view.
 * "Add step" ends it. Geometry in rail-model.ts.
 *
 * Fill it into a positioned box (its parent must be `position: relative` and as tall as the canvas): it reads the box's height. Drawn by the board
 * screen when it is built; today only the test page (app/(test)/v25-rail-parts) draws it.
 */
export function StepRail({ steps, current, onPick, onAdd }: {
  steps: readonly RailStep[];
  current: string | null;
  onPick: (id: string) => void;
  /** "Add step": absent, the button is not drawn. */
  onAdd?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [fade, setFade] = useState({ top: false, bottom: false });

  /* The canvas's height, before paint and on every resize: the rail never draws once at the wrong spacing. */
  useBeforePaint(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setHeight((before) => { const now = el.getBoundingClientRect().height; return Math.abs(now - before) < 0.5 ? before : now; });
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const geometry = railGeometry({ height: height || 700, count: steps.length });
  /* The geometry is set inline as style props, not as rules or custom properties in the sheet: its numbers change with the window and the step count. */
  const pad = { padding: `${geometry.gap}px 0` };
  const line = { height: geometry.gap };
  const circle = { width: geometry.circle, height: geometry.circle };
  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const next = { top: el.scrollTop > 6, bottom: el.scrollHeight - el.scrollTop - el.clientHeight > 6 };
    setFade((before) => (before.top === next.top && before.bottom === next.bottom ? before : next));
  };
  /* The fades follow the list's size (a step added, a window resized), and the current step is kept in view. */
  useEffect(() => {
    measure();
    /* Scrolls the list only (scrollIntoView would move the page too). */
    const list = scroller.current;
    const here = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !here) return;
    const a = here.getBoundingClientRect(), b = list.getBoundingClientRect();
    if (a.top < b.top) list.scrollTop += a.top - b.top;
    else if (a.bottom > b.bottom) list.scrollTop += a.bottom - b.bottom;
  }, [current, steps.length, height, geometry.gap, geometry.circle]);

  return (
    <div ref={wrap} className="v12-steprail-wrap" data-testid="v12-steprail-wrap">
      <nav className="v12-steprail" aria-label="Steps" data-testid="v12-steprail" data-compact={geometry.compact ? "" : undefined}>
        <div ref={scroller} className="v12-steprail-scroll" onScroll={measure}>
          {steps.map((step, index) => {
            const state = railState({ id: step.id, current, done: step.done });
            return (
              <Tooltip key={step.id} name={step.label} line={railTip({ status: step.status, optional: step.optional })}>
                <button type="button" className="v12-steprail-step" data-state={state} data-step={step.id} onClick={() => onPick(step.id)} style={pad}
                  aria-current={state === "current" ? "step" : undefined}>
                  {index > 0 ? <span className="v12-steprail-line" style={line} aria-hidden="true" /> : null}
                  <span className="v12-steprail-circle" style={circle}>
                    <svg width={geometry.icon} height={geometry.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={step.icon} /></svg>
                    {state === "done" ? (
                      <span className="v12-steprail-tick" data-testid="v12-steprail-tick" aria-hidden="true">
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5.2l2 2L8 3" /></svg>
                      </span>
                    ) : null}
                  </span>
                  <span className="v12-steprail-label">{step.label}</span>
                  {state === "current" ? <span className="v12-steprail-status" data-testid="v12-steprail-status">{step.status}</span> : null}
                </button>
              </Tooltip>
            );
          })}
          {onAdd ? (
            <Tooltip name="Add a step" line="Put another step on this board.">
              <button type="button" className="v12-steprail-add" onClick={onAdd} data-testid="v12-steprail-add" aria-label="Add step" style={{ padding: `${geometry.gap}px 0 2px` }}>
                <span className="v12-steprail-line" style={line} aria-hidden="true" />
                <span className="v12-steprail-circle v12-steprail-plus" style={circle} aria-hidden="true">+</span>
                {geometry.compact ? null : <span className="v12-steprail-label v12-steprail-addlabel">Add step</span>}
              </button>
            </Tooltip>
          ) : null}
        </div>
        {fade.top ? <span className="v12-steprail-fade" data-edge="top" aria-hidden="true" /> : null}
        {fade.bottom ? <span className="v12-steprail-fade" data-edge="bottom" aria-hidden="true" /> : null}
      </nav>
    </div>
  );
}
