"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { BEAT_LIMITS } from "@/lib/production/beats";
import type { ShotField, ShotRow } from "./model";
import "./doc.css";

/** A shot's state in the List view's last column (stream 5 supplies the rich one; the storyboard's until then). */
export type ShotState = { label: string; tone: "quiet" | "accent" | "done" | "waiting" | "failed" };

/**
 * The shot list (design/particl-graphite/README.md § 1.2: "the shot-list table is the board's List view"):
 * # · TIME · ACTION · SIZE · CAMERA · LENS · STATE, one row per shot of the beat sheet, edited in place.
 * Every edit goes to the draft through the callbacks (the Rig seam), which saves itself; a row taken out
 * comes back with Undo (the caller's toast). Clicking a row's number selects its card on the board.
 *
 * Narrow (a phone, or a narrow pane), each row stacks: no column ever runs past the screen.
 */
export function ShotListDoc({ rows, stateOf, readOnly, onField, onDuration, onAdd, onRemove, onSelect, testId = "board-shotlist" }: {
  rows: ShotRow[];
  stateOf: (shotId: string) => ShotState | null;
  /** Why nothing can be edited (offline, or the sample production), or null. */
  readOnly: string | null;
  onField: (shotId: string, field: ShotField, value: string) => void;
  onDuration: (shotId: string, seconds: number | null) => void;
  /** Adds an empty shot at the end; null when no more fit. */
  onAdd: (() => void) | null;
  onRemove: (shotId: string) => void;
  onSelect?: (shotId: string) => void;
  testId?: string;
}) {
  const locked = Boolean(readOnly);
  return (
    <section className="gx-shotlist" aria-label="Shot list" data-testid={testId}>
      <div className="gx-shotlist-head" aria-hidden="true">
        <span>#</span><span>Time</span><span>Action</span><span>Size</span><span>Camera · lens</span><span className="gx-shotlist-end">State</span>
      </div>
      {rows.map((row) => {
        const state = stateOf(row.id);
        return (
          <div key={row.id} className="gx-shotlist-row" role="group" aria-label={`Shot ${row.index}`} data-testid={`${testId}-row`}>
            {onSelect ? (
              <button type="button" className="gx-shotlist-n" onClick={() => onSelect(row.id)} aria-label={`Select shot ${row.index} on the board`}>{row.n}</button>
            ) : <span className="gx-shotlist-n">{row.n}</span>}
            <span className="gx-shotlist-time">
              {row.start != null && row.duration != null ? <span>{clockOnly(row.time)} ·</span> : null}
              <SecondsField index={row.index} value={row.duration} readOnly={locked} onCommit={(s) => onDuration(row.id, s)} />
            </span>
            <Cell multiline cls="gx-shotlist-action" label={`Shot ${row.index} action`} value={row.action} max={BEAT_LIMITS.description} readOnly={readOnly} placeholder="What the camera sees" onChange={(v) => onField(row.id, "description", v)} />
            <Cell cls="gx-shotlist-size" label={`Shot ${row.index} size`} value={row.size} max={BEAT_LIMITS.field} readOnly={readOnly} placeholder="Size" onChange={(v) => onField(row.id, "framing", v)} />
            <Cell cls="gx-shotlist-camera" label={`Shot ${row.index} camera and lens`} value={row.camera} max={BEAT_LIMITS.field} readOnly={readOnly} placeholder="Camera · lens" onChange={(v) => onField(row.id, "movement", v)} />
            <span className="gx-shotlist-state gx-shotlist-end" data-tone={state?.tone ?? "quiet"} data-testid={`${testId}-state`}>
              {state ? <><span className="gx-shotlist-dot" aria-hidden="true" />{state.label}</> : null}
            </span>
            {locked ? null : (
              <button type="button" className="gx-shotlist-remove" onClick={() => onRemove(row.id)} aria-label={`Take shot ${row.index} out of the list`} title="Take this shot out (Undo brings it back)">×</button>
            )}
          </div>
        );
      })}
      {!rows.length ? <p className="gx-shotlist-empty" data-testid={`${testId}-empty`}>No shots yet.</p> : null}
      {locked ? null : (
        <button type="button" className="gx-shotlist-add" disabled={!onAdd} onClick={() => onAdd?.()} data-testid={`${testId}-add`}>+ Shot</button>
      )}
    </section>
  );
}

/** "0:04 · 6 s" → "0:04": the start, when the row's time has one. */
function clockOnly(time: string): string {
  return time.split(" · ")[0];
}

/** A cell edited in place; it keeps what is typed while it has focus, and takes the draft's value once it lets go. */
function Cell({ cls, label, value, max, readOnly, placeholder, multiline = false, onChange }: {
  cls: string; label: string; value: string; max: number; readOnly: string | null; placeholder: string; multiline?: boolean; onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!focused && value !== seen) { setSeen(value); setText(value); }
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const props = {
    className: `gx-shotlist-cell ${cls}`,
    "aria-label": label, value: text, maxLength: max, readOnly: Boolean(readOnly), title: readOnly ?? undefined,
    placeholder: readOnly ? "" : placeholder,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onChange: (e: { target: { value: string } }) => { if (readOnly) return; setText(e.target.value); onChange(e.target.value); },
  };
  return multiline ? <textarea ref={area} rows={1} {...props} /> : <input type="text" {...props} />;
}

/** A shot's length in seconds, committed when it is left (Enter or a click away); empty clears it. */
function SecondsField({ index, value, readOnly, onCommit }: { index: number; value: number | null; readOnly: boolean; onCommit: (seconds: number | null) => void }) {
  const shown = value == null ? "" : String(value);
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  const [focused, setFocused] = useState(false);
  if (!focused && shown !== seen) { setSeen(shown); setText(shown); }
  const cancelled = useRef(false);
  const commit = (typed: string) => {
    if (cancelled.current) { cancelled.current = false; setText(shown); return; }
    const trimmed = typed.trim();
    if (trimmed === shown) return;
    const n = Number(trimmed);
    if (!trimmed) onCommit(null);
    else if (Number.isFinite(n) && n > 0) onCommit(n);
    else setText(shown);
  };
  return (
    <span className="gx-shotlist-secs">
      <input type="text" inputMode="decimal" className="gx-shotlist-cell gx-shotlist-num" aria-label={`Shot ${index} length in seconds`} value={text}
        readOnly={readOnly} onChange={(e) => setText(e.target.value)} onFocus={() => setFocused(true)}
        onBlur={(e) => { setFocused(false); commit(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
        }} />
      <span aria-hidden="true">s</span>
    </span>
  );
}
