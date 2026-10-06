"use client";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { MAX_SCRIPT_CHARS } from "@/lib/workbench/screenplay";
import { typingIn } from "../review/review-model";
import type { BoardCtx } from "../cards/types";
import { clock, readSaved, scriptFrom, speakerName, srtFrom, stamp, subscribeSaved, writeSaved, type SavedTranscript } from "./transcript-model";
import { closeTranscript, useOpenTranscript } from "./transcript-panel-store";
import "./transcribe.css";

/** One line's words, edited in place; saved in this browser when the field is left. */
function LineText({ value, label, onCommit }: { value: string; label: string; onCommit: (text: string) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const fit = () => { const el = field.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(fit, [value]);
  return (
    <textarea ref={field} className="gx-tp-text" rows={1} defaultValue={value} aria-label={label} maxLength={4000} onInput={fit}
      onBlur={(e) => { const next = e.target.value; if (next !== value) onCommit(next); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); (e.target as HTMLElement).blur(); } }} />
  );
}

function Panel({ ctx, slot, name }: { ctx: BoardCtx; slot: string; name: string }) {
  const raw = useSyncExternalStore(subscribeSaved, () => JSON.stringify(readSaved(slot)), () => "null");
  const saved = useMemo(() => (raw && raw !== "null" ? (JSON.parse(raw) as SavedTranscript) : null), [raw]);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !typingIn(e.target)) { e.preventDefault(); closeTranscript(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!saved) return null;
  const edit = (i: number, text: string) => writeSaved(slot, { ...saved, edited: true, lines: saved.lines.map((l, j) => (j === i ? { ...l, text } : l)) });
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const script = scriptFrom(saved.lines);

  /* Into the Brief: the project's script. What it replaces is kept, and the toast's Undo puts it back. */
  const useAsScript = () => {
    if (!script.trim()) { ctx.toast("There are no words in this transcript to use."); return; }
    if (script.length > MAX_SCRIPT_CHARS) { ctx.toast("This transcript is longer than a script can be."); return; }
    const before = ctx.project.script ?? "";
    const refused = ctx.rig.apply((p) => ({ ...p, script }));
    if (refused) { ctx.toast(refused); return; }
    void ctx.rig.save();
    ctx.toast(before.trim() ? "The transcript is the script now. The earlier script is kept under Undo." : "The transcript is the script now.", {
      label: "Undo", run: () => { ctx.rig.apply((p) => ({ ...p, script: before })); void ctx.rig.save(); },
    });
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([srtFrom(saved.lines, saved.seconds)], { type: "application/x-subrip" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/[^\w.-]+/g, "_") || "transcript"}.srt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <aside ref={box} className="gx-tp" role="dialog" aria-label="Transcript" tabIndex={-1} data-testid="transcript-panel">
      <div className="gx-tp-head">
        <div>
          <h2 className="gx-tp-title">Transcript</h2>
          <p className="gx-tp-meta">{name} · {clock(saved.seconds)} · {saved.lines.length} {saved.lines.length === 1 ? "line" : "lines"}{saved.language ? ` · ${saved.language}` : ""} · edit any line</p>
        </div>
        <button type="button" className="gx-tp-btn" onClick={closeTranscript} data-testid="transcript-close">Close</button>
      </div>
      <ol className="gx-tp-lines gx-scroll" data-testid="transcript-lines">
        {saved.lines.map((line, i) => (
          <li className="gx-tp-line" key={i}>
            <span className="gx-tp-at">{stamp(line.at)}</span>
            <span className="gx-tp-who">{speakerName(line) ?? ""}</span>
            <LineText value={line.text} label={`Line at ${stamp(line.at)}`} onCommit={(text) => edit(i, text)} />
          </li>
        ))}
        {!saved.lines.length ? <li className="gx-tp-line"><span className="gx-tp-text">No speech was found in this source.</span></li> : null}
      </ol>
      <div className="gx-tp-foot">
        <button type="button" className="gx-tp-btn" onClick={() => void navigator.clipboard?.writeText(script)} data-testid="transcript-copy">Copy text</button>
        <button type="button" className="gx-tp-btn" onClick={download} data-testid="transcript-srt">Download subtitles (.srt)</button>
        <button type="button" className="gx-tp-btn" data-primary="" disabled={Boolean(blocked) || !script.trim()} title={blocked ?? undefined} onClick={useAsScript} data-testid="transcript-script">Use as script · free</button>
      </div>
    </aside>
  );
}

/** The transcript side panel the board mounts once (components/graphite/board/GapOverlays.tsx). */
export function TranscriptPanel({ ctx }: { ctx: BoardCtx }) {
  const open = useOpenTranscript();
  return open ? <Panel key={open.slot} ctx={ctx} slot={open.slot} name={open.name} /> : null;
}
