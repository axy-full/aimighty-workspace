"use client";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ContextMenu, Menu, Tooltip, type MenuItem } from "../ui";
import { STAGE_PRESETS, type StageEdit } from "@/lib/v12/board/stages";
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
  /** Skipped by the person: drawn muted; "Put it back" is in its menu. */
  skipped?: boolean;
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
export function StepRail({ steps, current, onPick, onAdd, onEdit, readOnly }: {
  steps: readonly RailStep[];
  current: string | null;
  onPick: (id: string) => void;
  /** "Add step": absent, the button is not drawn. With `onEdit` and no `onAdd` it opens the board's presets (Moodboard, Recce, Client review, Animatic) and "Custom…", and adds the pick after the current step. */
  onAdd?: () => void;
  /**
   * What a person changes on the rail: drag a step (or Alt+↑ / Alt+↓ on it) to reorder, right-click it (or the menu key) to Rename, Skip or Put it back,
   * or Remove. The same edits the board keeps in its draft (lib/v12/board/stages.ts `applyStageEdit`); a removed built-in step stays removed.
   */
  onEdit?: (edit: StageEdit) => void;
  readOnly?: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; pointer?: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addAnchor = useRef<HTMLButtonElement>(null);
  const editable = Boolean(onEdit) && !readOnly;
  const move = (id: string, index: number) => { if (editable) onEdit!({ type: "move", id, index: Math.max(0, Math.min(steps.length - 1, index)) }); };
  const drop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const id = dragging;
    setDragging(null); setOver(null);
    if (!id || !editable) return;
    const from = steps.findIndex((s) => s.id === id);
    /* The line sits above step `index`: in the list without the dragged step that is one less when it came from above. */
    const to = from < index ? index - 1 : index;
    if (from >= 0 && to !== from) move(id, to);
  };
  const keys = (event: KeyboardEvent, id: string, index: number) => {
    if (!editable || !event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); move(id, index + (event.key === "ArrowUp" ? -1 : 1)); }
  };
  const addItems: MenuItem[] = [
    ...STAGE_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.line, onSelect: () => onEdit?.({ type: "add", after: current, label: p.label }) })),
    { id: "custom", label: "Custom…", hint: "name it", onSelect: () => onEdit?.({ type: "add", after: current, label: "New step" }) },
  ];
  const menuItems = (id: string): MenuItem[] => {
    const step = steps.find((s) => s.id === id);
    if (!step) return [];
    return [
      { id: "rename", label: "Rename", onSelect: () => setRenaming(id) },
      { id: "skip", label: step.skipped ? "Put it back" : "Skip this step", onSelect: () => onEdit?.({ type: "skip", id, skipped: !step.skipped }) },
      { id: "remove", label: "Remove", tone: "danger", disabled: steps.length <= 1, onSelect: () => onEdit?.({ type: "remove", id }) },
    ];
  };
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
            if (renaming === step.id) {
              return (
                <div key={step.id} className="v12-steprail-step" data-state={state} data-step={step.id} style={pad}>
                  {index > 0 ? <span className="v12-steprail-line" style={line} aria-hidden="true" /> : null}
                  <span className="v12-steprail-circle" style={circle}><svg width={geometry.icon} height={geometry.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={step.icon} /></svg></span>
                  <RenameField value={step.label} onDone={(label) => { setRenaming(null); if (label && label !== step.label) onEdit?.({ type: "rename", id: step.id, label }); }} />
                </div>
              );
            }
            return (
              <Tooltip key={step.id} name={step.label} line={railTip({ status: step.status, optional: step.optional })}>
                <button type="button" className="v12-steprail-step" data-state={state} data-step={step.id} onClick={() => onPick(step.id)} style={pad}
                  data-skipped={step.skipped ? "" : undefined} data-dragging={dragging === step.id ? "" : undefined} data-drop={over === index && dragging ? "" : undefined}
                  aria-current={state === "current" ? "step" : undefined} aria-label={step.skipped ? `${step.label}, skipped` : undefined}
                  draggable={editable || undefined}
                  onDragStart={editable ? (event) => { setDragging(step.id); event.dataTransfer.effectAllowed = "move"; try { event.dataTransfer.setData("application/x-particl-step", step.id); } catch { /* read-only */ } } : undefined}
                  onDragOver={editable ? (event) => { if (dragging) { event.preventDefault(); setOver(index); } } : undefined}
                  onDragLeave={editable ? () => setOver((o) => (o === index ? null : o)) : undefined}
                  onDrop={editable ? (event) => drop(event, index) : undefined} onDragEnd={editable ? () => { setDragging(null); setOver(null); } : undefined}
                  onKeyDown={(event) => keys(event, step.id, index)}
                  onContextMenu={editable ? (event) => { event.preventDefault(); setMenu({ id: step.id, x: event.clientX, y: event.clientY, pointer: event.detail > 0 }); } : undefined}>
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
          {onAdd || editable ? (
            <Tooltip name="Add a step" line="Put another step on this board.">
              <button ref={addAnchor} type="button" className="v12-steprail-add" onClick={() => (onAdd ? onAdd() : setAdding(true))} aria-haspopup={onAdd ? undefined : "menu"} aria-expanded={onAdd ? undefined : adding} data-testid="v12-steprail-add" aria-label="Add step" style={{ padding: `${geometry.gap}px 0 2px` }}>
                <span className="v12-steprail-line" style={line} aria-hidden="true" />
                <span className="v12-steprail-circle v12-steprail-plus" style={circle} aria-hidden="true">+</span>
                {geometry.compact ? null : <span className="v12-steprail-label v12-steprail-addlabel">Add step</span>}
              </button>
            </Tooltip>
          ) : null}
        </div>
        {!onAdd ? <Menu open={adding} onClose={() => setAdding(false)} anchor={addAnchor} label="Add a step" items={addItems} side="right" width={240} /> : null}
        <ContextMenu at={menu ? { x: menu.x, y: menu.y, pointer: menu.pointer } : null} onClose={() => setMenu(null)} label={steps.find((x) => x.id === menu?.id)?.label ?? "Step"} items={menu ? menuItems(menu.id) : []} width={200} testId="v12-steprail-menu" />
        {fade.top ? <span className="v12-steprail-fade" data-edge="top" aria-hidden="true" /> : null}
        {fade.bottom ? <span className="v12-steprail-fade" data-edge="bottom" aria-hidden="true" /> : null}
      </nav>
    </div>
  );
}

/** A step's new name: Enter keeps it, Esc and a click away leave it as it was. */
function RenameField({ value, onDone }: { value: string; onDone: (label: string | null) => void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  const finish = (label: string | null) => { if (done.current) return; done.current = true; onDone(label); };
  return (
    <input ref={field} className="v12-steprail-rename" aria-label="Step name" maxLength={40} value={text} onChange={(event) => setText(event.target.value)} data-testid="v12-steprail-rename"
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finish(text.trim() || null); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); } }}
      onBlur={() => finish(text.trim() || null)} />
  );
}
