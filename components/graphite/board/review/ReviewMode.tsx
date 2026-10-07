"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useProjectLibrary } from "@/lib/workspace/library";
import type { BoardCtx } from "../cards/types";
import { rejectReasonProblem, shotTakes, type ShotTakes, type ShotVersion } from "../cards/take/take-model";
import { REJECT_REASON_MAX, useJudge } from "../cards/take/use-judge";
import { useProvideBoardSeam } from "../BoardContext";
import {
  COMPARE_LABEL, COMPARE_MODES, REVIEW_KEYS, compareBase, nextCompare, positionWords, reviewAction, reviewQueue, reviewVersion, startIndex, typingIn,
  type CompareMode, type ReviewAction,
} from "./review-model";
import "./review.css";

/*
 * Review mode (README § 3.1 frame l, § 6; U1 item 6): one take at a time, full screen under the header.
 * J and K step through the shots' takes, A approves, R rejects with a reason (saved as a note on the take),
 * Space plays, C compares the take with another version side by side or with a slider, Esc closes.
 * Judging is free and never spends; it goes through the same review trail as the cards (use-judge).
 * The board opens it through its review seam (a take card's double-click or Enter, Atomik's "Review full
 * screen"); stream 3's BoardView mounts it.
 */

type Opened = { takeId: string | null };

export function BoardReview({ ctx }: { ctx: BoardCtx }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const open = useCallback((takeId?: string) => setOpened({ takeId: takeId ?? null }), []);
  useProvideBoardSeam("review", open);
  if (!opened || typeof document === "undefined") return null;
  /* On the page itself, so nothing the board is drawn inside (a transform, a fade) changes how it covers the screen. */
  return createPortal(<ReviewOverlay ctx={ctx} takeId={opened.takeId} onClose={() => setOpened(null)} />, document.body);
}

function ratioVars(aspect: string): CSSProperties {
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  const [w, h] = m && Number(m[1]) > 0 && Number(m[2]) > 0 ? [m[1], m[2]] : ["16", "9"];
  return { "--rv-w": w, "--rv-h": h } as CSSProperties;
}

function Media({ version, mediaRef, label, accent }: { version: ShotVersion; mediaRef?: (el: HTMLVideoElement | null) => void; label?: string; accent?: boolean }) {
  return (
    <div className="gx-review-media" data-accent={accent || undefined}>
      {version.media === "video"
        ? <video ref={mediaRef} src={version.url ?? undefined} playsInline preload="metadata" className="gx-review-el" data-testid="review-video" />
        /* eslint-disable-next-line @next/next/no-img-element */
        : <img src={version.url ?? undefined} alt="" className="gx-review-el" draggable={false} data-testid="review-image" />}
      {label ? <span className="gx-review-label" data-accent={accent || undefined}>{label}</span> : null}
    </div>
  );
}

function ReviewOverlay({ ctx, takeId, onClose }: { ctx: BoardCtx; takeId: string | null; onClose: () => void }) {
  const library = useProjectLibrary(ctx.scope, ctx.project.id);
  const rows = useMemo(() => shotTakes(ctx.project, library.items), [ctx.project, library.items]);
  const queue = useMemo(() => reviewQueue(rows), [rows]);
  const judge = useJudge(ctx.scope, ctx.project.id, ctx.toast);
  const [nodeId, setNodeId] = useState<string | null>(null);
  /* The version on screen stays on screen when it is judged (its shot's current version may change under it). */
  const [picked, setPicked] = useState<string | null>(takeId);
  const [compare, setCompare] = useState<CompareMode>("single");
  const [slider, setSlider] = useState(50);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const reasonInput = useRef<HTMLInputElement>(null);
  const videos = useRef(new Set<HTMLVideoElement>());

  const held = nodeId ? queue.findIndex((r) => r.nodeId === nodeId) : -1;
  const index = held >= 0 ? held : startIndex(queue, takeId);
  const row: ShotTakes | null = index >= 0 ? queue[index] : null;
  const version = row ? reviewVersion(row, picked) : null;
  const base = row && version ? compareBase(row, version) : null;
  const mode: CompareMode = base ? compare : "single";

  /* Focus comes into the dialog, and goes back where it was when review mode closes. */
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => { if (rejecting) reasonInput.current?.focus(); }, [rejecting]);

  const pauseAll = useCallback(() => { videos.current.forEach((v) => v.pause()); setPlaying(false); }, []);
  const go = useCallback((step: 1 | -1) => {
    if (index < 0) return;
    const next = Math.max(0, Math.min(queue.length - 1, index + step));
    if (next === index) return;
    pauseAll();
    setNodeId(queue[next].nodeId); setPicked(null); setRejecting(false); setReason(""); setHint(null);
  }, [index, queue, pauseAll]);

  const approve = useCallback(() => {
    if (!row || !version || ctx.offline || version.status === "approved") return;
    setPicked(version.genId);
    void judge.approve(row, version);
  }, [row, version, ctx.offline, judge]);
  const confirmReject = useCallback(() => {
    if (!row || !version || ctx.offline) return;
    const problem = rejectReasonProblem(reason);
    if (problem) { setHint(problem); reasonInput.current?.focus(); return; }
    setHint(null);
    setPicked(version.genId);
    void judge.reject(row, version, reason).then((ok) => { if (ok) { setRejecting(false); setReason(""); dialog.current?.focus(); } });
  }, [row, version, ctx.offline, judge, reason]);
  const togglePlay = useCallback(() => {
    const list = [...videos.current].filter((v) => v.isConnected);
    if (!list.length) return;
    if (playing) { pauseAll(); return; }
    Promise.all(list.map((v) => v.play())).then(() => setPlaying(true), () => setPlaying(false));
  }, [playing, pauseAll]);

  const run = useCallback((action: ReviewAction) => {
    switch (action) {
      case "prev": go(-1); return;
      case "next": go(1); return;
      case "approve": approve(); return;
      case "reject":
        if (!version || ctx.offline || version.status === "changes") return;
        setRejecting(true); return;
      case "play": togglePlay(); return;
      case "compare": if (base) setCompare((m) => nextCompare(m)); return;
      case "close":
        if (rejecting) { setRejecting(false); setHint(null); dialog.current?.focus(); return; }
        pauseAll(); onClose(); return;
    }
  }, [go, approve, version, ctx.offline, togglePlay, base, rejecting, pauseAll, onClose]);

  /* The review keys win over the board's and the shell's while review mode is open, never inside a field. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const box = dialog.current;
        const items = box ? [...box.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), video[controls]")] : [];
        if (!box || !items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (typingIn(e.target)) return;
      const action = reviewAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      run(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run]);

  const track = useCallback((el: HTMLVideoElement | null) => {
    if (el) { videos.current.add(el); el.onended = () => setPlaying(false); }
    for (const v of [...videos.current]) if (!v.isConnected) videos.current.delete(v);
  }, []);

  const title = row ? `Shot ${row.index} · ${row.name}` : "Review";
  const judgeTitle = ctx.offline ? "Needs a connection" : undefined;
  return (
    <div ref={dialog} className="gx-review" role="dialog" aria-modal="true" aria-label={`Review · ${title}`} tabIndex={-1} style={ratioVars(ctx.project.aspect)} data-testid="review-mode">
      <div className="gx-review-top">
        <div className="gx-review-heading">
          <strong className="gx-review-title">{title}</strong>
          {row && version ? <span className="gx-review-meta" data-testid="review-position">{positionWords(index, queue.length, version.label)}</span> : null}
        </div>
        <div className="gx-review-tools">
          <div className="gx-review-seg" role="radiogroup" aria-label="Compare">
            {COMPARE_MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className="gx-review-seg-btn" disabled={m !== "single" && !base}
                title={m !== "single" && !base ? "One version only" : undefined} onClick={() => setCompare(m)} data-testid={`review-compare-${m}`}>{COMPARE_LABEL[m]}</button>
            ))}
          </div>
          <button type="button" className="gx-review-btn" onClick={() => run("close")} data-testid="review-close">Close</button>
        </div>
      </div>

      <div className="gx-review-stage" data-mode={mode}>
        {!row || !version ? null : mode === "side" && base ? (
          <>
            <Media key={`b:${base.genId}`} version={base} label={base.label} mediaRef={track} />
            <Media key={`v:${version.genId}`} version={version} label={version.label} accent mediaRef={track} />
          </>
        ) : mode === "slider" && base ? (
          <div className="gx-review-slider" style={{ "--rv-split": `${slider}%` } as CSSProperties}>
            <Media key={`b:${base.genId}`} version={base} mediaRef={track} />
            <div className="gx-review-clip"><Media key={`v:${version.genId}`} version={version} mediaRef={track} /></div>
            <span className="gx-review-split" aria-hidden="true" />
            <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(Number(e.target.value))} aria-label="Compare" className="gx-review-range" data-testid="review-slider" />
          </div>
        ) : (
          <div className="gx-review-single">
            <Media key={`v:${version.genId}`} version={version} mediaRef={track} />
            {version.media === "video" ? (
              <button type="button" className="gx-review-play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} data-testid="review-play">{playing ? "❚❚" : "▶"}</button>
            ) : null}
          </div>
        )}
      </div>

      <div className="gx-review-bottom">
        {rejecting && version ? (
          <form className="gx-review-reason" onSubmit={(e) => { e.preventDefault(); confirmReject(); }}>
            <input ref={reasonInput} className="gx-review-input" value={reason} maxLength={REJECT_REASON_MAX} onChange={(e) => { setReason(e.target.value); setHint(null); }} placeholder="Why reject it?"
              aria-label="Reason for rejecting" aria-invalid={hint ? true : undefined} aria-describedby={hint ? "review-reason-hint" : undefined} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); run("close"); } }} data-testid="review-reason" />
            {hint ? <span id="review-reason-hint" className="gx-review-hint" role="alert" data-testid="review-reason-hint">{hint}</span> : null}
          </form>
        ) : (
          <div className="gx-review-keys" aria-hidden="true">
            {REVIEW_KEYS.map((k) => <span key={k.key} className="gx-review-key"><kbd>{k.key}</kbd>{k.label}</span>)}
          </div>
        )}
        <div className="gx-review-acts">
          <button type="button" className="gx-review-btn" onClick={() => run("prev")} disabled={index <= 0} data-testid="review-prev">Previous</button>
          {/* Pressed once it asks for the reason; pressed again (or Enter in the field) it rejects. */}
          <button type="button" className={`gx-review-btn${rejecting ? " gx-review-btn--danger" : ""}`} onClick={() => (rejecting ? confirmReject() : run("reject"))} aria-expanded={rejecting}
            disabled={!version || ctx.offline || version.status === "changes" || Boolean(judge.busy)} title={judgeTitle} data-testid="review-reject">
            {version?.status === "changes" ? "Rejected" : "Reject"}
          </button>
          <button type="button" className="gx-review-btn gx-review-btn--primary" onClick={() => run("approve")} disabled={!version || ctx.offline || version.status === "approved" || Boolean(judge.busy)} title={judgeTitle} data-testid="review-approve">
            {version?.status === "approved" ? "Approved" : "Approve"}
          </button>
          <button type="button" className="gx-review-btn" onClick={() => run("next")} disabled={index < 0 || index >= queue.length - 1} data-testid="review-next">Next</button>
        </div>
      </div>
    </div>
  );
}
