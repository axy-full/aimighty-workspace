"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton, Tooltip } from "../ui";
import { withOther, rejectReason } from "./card-model";
import {
  approveLabel, canCompare, clampIndex, compareSides, judgeVersion, stepFrame, stepId, timeLabel, versionDownload, versionOf, waveBars,
  type PreviewItemView,
} from "./preview-model";
import "./card-preview.css";

/**
 * The v25 preview (PR 6; design/particl-prototype-25 README, "Double-click or Space: Preview with versions, Compare, ✓ / ✕ for the version shown,
 * Download, ← / →"): a picture, a clip with its controls, a sound with its waveform, or a page of words (with its tabs, for a script), over the board's
 * area. Its header says which card and which version ("v2 of 3"), then ✓ and ✕ for the version on screen, Download, Compare (with two or more
 * versions) and ×. Under it a strip of the versions; pressing one shows it. Compare sets the version before the one on screen (A) beside it (B). ← and →
 * step through the step's cards; Esc closes the reasons, then the preview, and the focus goes back to where it was.
 *
 * Controlled by the board: `ids` is the order ← and → walk, `openId` the card on screen. ✓ / ✕ are the board's (they go through the review trail,
 * components/v12/board/ShotPreview.tsx); this draws them. `inset` leaves room for the column and the bar in Director mode.
 */
export type CardPreviewProps = {
  items: ReadonlyMap<string, PreviewItemView> | readonly PreviewItemView[];
  ids: readonly string[];
  openId: string;
  onStep: (id: string) => void;
  onClose: () => void;
  /** ✓ on the version on screen: approve it, or take the approval back when it is already approved. */
  onApprove?: (item: PreviewItemView, versionIndex: number) => void;
  onReject?: (item: PreviewItemView, versionIndex: number, reason: string) => void;
  /** The version the board shows changed (a version pressed in the strip): the board may follow. */
  onVersion?: (item: PreviewItemView, versionIndex: number) => void;
  /** The room the column (right) and the bar (bottom) take in Director mode, in px. */
  inset?: { right?: number; bottom?: number };
  /** A line beside the actions ("The column and the bar act on this shot."). */
  note?: string;
  placement?: "absolute" | "fixed";
};

/** A picture of the board's own (a take, a frame): a plain image, as the rest of the new interface draws them. */
function Img({ src, className, testId }: { src: string; className?: string; testId?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} data-testid={testId} />;
}

const isField = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

export function CardPreview(props: CardPreviewProps) {
  const { ids, openId, onStep, onClose, inset, note, placement = "absolute" } = props;
  const item = (Array.isArray(props.items) ? (props.items as PreviewItemView[]).find((i) => i.id === openId) : (props.items as ReadonlyMap<string, PreviewItemView>).get(openId)) ?? null;
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [picked, setPicked] = useState<{ id: string; index: number } | null>(null);
  const [compare, setCompare] = useState(false);
  const [tab, setTab] = useState<{ id: string; tab: string } | null>(null);
  /* ✕'s reasons belong to one version of one card: another card or version has its own, closed. */
  const [rs, setRs] = useState<{ key: string; pick: string | null; line: string } | null>(null);
  const panelId = useId();

  /* The version on screen: the one pressed in the strip for this card, else the card's own shown one. */
  const index = item ? clampIndex(picked && picked.id === item.id ? picked.index : item.shown, item.versions.length) : 0;
  const version = item?.versions[index] ?? null;
  const comparing = Boolean(item && compare && canCompare(item));
  const tabNow = item?.tabs?.length ? (item.tabs.find((t) => t.id === (tab && tab.id === item.id ? tab.tab : item.tabs![0].id)) ?? item.tabs[0]) : null;
  const judge = item ? judgeVersion(item, index) : null;
  const reasonKey = `${openId}:${index}`;
  const reasoning = rs?.key === reasonKey;
  const pick = reasoning ? rs.pick : null;
  const line = reasoning ? rs.line : "";

  /* The focus goes in when the preview opens and back to where it was when it closes. */
  useEffect(() => {
    /* Where the focus was when it opened, taken once (a development build runs this effect twice, and the second time the focus is already here). */
    if (!returnTo.current && document.activeElement instanceof HTMLElement && !root.current?.contains(document.activeElement)) returnTo.current = document.activeElement;
    root.current?.focus({ preventScroll: true });
    return () => { const back = returnTo.current; if (back && back.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true })); };
  }, []);

  const closeReasons = () => setRs(null);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (reasoning) closeReasons(); else onClose();
        return;
      }
      /* The arrows are a field's, a tab's, the audio player's and a clip's own when the focus is on them. */
      if (isField(event.target) || (event.target instanceof HTMLElement && event.target.closest('[role="tab"], [role="slider"], audio, video'))) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); onStep(stepId(ids, openId, -1)); }
      else if (event.key === "ArrowRight") { event.preventDefault(); onStep(stepId(ids, openId, 1)); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [ids, openId, onStep, onClose, reasoning]);

  if (!item || !version) return null;
  const choose = (i: number) => { setPicked({ id: item.id, index: i }); props.onVersion?.(item, i); };
  const send = (chosen: string | null, text: string) => { if (judge) props.onReject?.(item, index, rejectReason(chosen, text)); closeReasons(); root.current?.focus({ preventScroll: true }); };
  const sides = comparing ? compareSides(item, index) : null;
  const download = versionDownload(version);
  const style = { right: inset?.right ?? 0, bottom: inset?.bottom ?? 0 };

  return (
    <div ref={root} className="v12-pv" data-placement={placement} style={style} role="dialog" aria-label={`Preview: ${item.title}`} tabIndex={-1} data-testid="v12-preview"
      /* Not aria-modal: the preview covers the board's area but leaves the column and the bar (Director mode) in reach, so the rest of the page is not inert. */
      data-kind={item.kind} data-compare={comparing ? "" : undefined} onClick={(event) => event.stopPropagation()}>
      <div className="v12-pv-head">
        <span className="v12-pv-title" data-testid="v12-preview-title">{item.title}</span>
        {versionOf(item, index) ? <span className="v12-pv-ver" data-testid="v12-preview-version">{versionOf(item, index)}</span> : null}
        {item.poweredBy ? <span className="v12-pv-by">Powered by {item.poweredBy}</span> : null}
        <span className="v12-pv-note">{note ?? ""}</span>
        <span className="v12-pv-acts">
          {judge ? (
            <>
              <button type="button" className="v12-pv-btn" data-mark="ok" aria-pressed={version.status === "approved"} data-testid="v12-preview-ok"
                title={version.status === "approved" && version.approvedBy ? `Approved by ${version.approvedBy}. Press again to undo.` : version.status === "approved" ? "Press again to undo." : "Approve this version"}
                onClick={() => props.onApprove?.(item, index)}>✓ {approveLabel(item, index)}</button>
              <Tooltip name="Not right" line="Say why.">
                <button type="button" className="v12-pv-btn" data-mark="no" aria-expanded={reasoning} aria-controls={reasoning ? panelId : undefined} data-testid="v12-preview-no"
                  aria-label="Not right" onClick={() => (reasoning ? closeReasons() : setRs({ key: reasonKey, pick: null, line: "" }))}>✕</button>
              </Tooltip>
            </>
          ) : null}
          {download ? (
            <Tooltip name="Download" line="The original file.">
              <a className="v12-pv-btn v12-pv-icon" href={download} download aria-label="Download" data-testid="v12-preview-download">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v8M5 7l3 3 3-3M3 13h10" /></svg>
              </a>
            </Tooltip>
          ) : null}
          {canCompare(item) ? <button type="button" className="v12-pv-btn" aria-pressed={comparing} data-testid="v12-preview-compare" onClick={() => setCompare((on) => !on)}>Compare</button> : null}
          <IconButton className="v12-pv-x" size="sm" label="Close" tooltip={{ name: "Close", shortcut: "Esc" }} onClick={onClose} data-testid="v12-preview-close">×</IconButton>
        </span>
      </div>
      <div className="v12-pv-stage">
        <Tooltip name="Previous" shortcut="←" side="right">
          <button type="button" className="v12-pv-step" data-side="prev" aria-label="Previous" onClick={() => onStep(stepId(ids, openId, -1))}>‹</button>
        </Tooltip>
        {sides ? (
          <div className="v12-pv-compare" data-testid="v12-preview-compare-view">
            {[sides.a, sides.b].map((at, slot) => {
              const v = item.versions[at];
              return (
                <div key={slot} className="v12-pv-side" data-side={slot === 0 ? "a" : "b"}>
                  {v.poster ? <Img src={v.poster} className="v12-pv-img" /> : <span className="v12-pv-empty">No picture</span>}
                  <span className="v12-pv-tag" data-testid="v12-preview-compare-label">{v.label}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="v12-pv-one">
            {item.kind === "picture" && version.poster ? <Img src={version.poster} className="v12-pv-img" testId="v12-preview-picture" /> : null}
            {item.kind === "video" ? <Clip key={`${item.id}:${index}`} src={version.url} poster={version.poster} /> : null}
            {item.kind === "sound" ? <Sound key={`${item.id}:${index}`} src={version.url} seed={`${item.id}:${version.genId ?? version.label}`} /> : null}
            {item.kind === "text" ? (
              <div className="v12-pv-page">
                {item.tabs?.length ? (
                  <div className="v12-pv-tabs" role="tablist" aria-label="Page">
                    {item.tabs.map((t) => (
                      <button key={t.id} type="button" role="tab" aria-selected={tabNow?.id === t.id} className="v12-pv-tab" data-testid="v12-preview-tab" onClick={() => setTab({ id: item.id, tab: t.id })}>{t.label}</button>
                    ))}
                  </div>
                ) : null}
                <div className="v12-pv-text" role={item.tabs?.length ? "tabpanel" : undefined} data-testid="v12-preview-text">{tabNow ? tabNow.text : item.text}</div>
              </div>
            ) : null}
            {item.kind === "picture" && !version.poster ? <span className="v12-pv-empty">No picture yet</span> : null}
          </div>
        )}
        <Tooltip name="Next" shortcut="→" side="left">
          <button type="button" className="v12-pv-step" data-side="next" aria-label="Next" onClick={() => onStep(stepId(ids, openId, 1))}>›</button>
        </Tooltip>
        {reasoning && judge ? (
          <div id={panelId} className="v12-pv-reasons" data-testid="v12-preview-reasons">
            <span className="v12-pv-reasons-label">What’s wrong{versionOf(item, index) ? ` with ${version.label}` : ""}?</span>
            <div className="v12-pv-reasons-list" role="group" aria-label="What’s wrong?">
              {withOther(item.reasons).map((reason) => (
                <button key={reason} type="button" className="v12-pv-reason" data-on={pick === reason ? "" : undefined} aria-pressed={pick === reason}
                  onClick={() => { if (reason === "Other") setRs({ key: reasonKey, pick: reason, line }); else send(reason, line); }}>{reason}</button>
              ))}
            </div>
            <input className="v12-pv-line" value={line} aria-label="One line, optional" placeholder="One line, optional · ⏎ to send" onChange={(event) => setRs({ key: reasonKey, pick, line: event.target.value })}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); send(pick, line); } }} />
          </div>
        ) : null}
      </div>
      <div className="v12-pv-versions" data-testid="v12-preview-versions" role="group" aria-label="Versions">
        <span className="v12-pv-versions-label">Versions</span>
        {item.versions.map((v, i) => (
          <button key={v.genId ?? v.label} type="button" className="v12-pv-vbtn" aria-pressed={i === index} aria-label={`${v.label}${v.status === "approved" ? ", approved" : ""}`} data-testid="v12-preview-version-btn" onClick={() => choose(i)}>
            <span className="v12-pv-thumb">{v.poster ? <Img src={v.poster} /> : null}</span>
            <span className="v12-pv-vlabel">{v.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A clip with the prototype's controls: play, one frame back and forward, a scrub bar and the time. */
function Clip({ src, poster }: { src: string | null; poster: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const set = (next: number) => { if (video.current) { video.current.currentTime = next; setT(next); } };
  return (
    <div className="v12-pv-clip">
      <video ref={video} className="v12-pv-media" src={src ?? undefined} poster={poster ?? undefined} playsInline preload="metadata" data-testid="v12-preview-video"
        onTimeUpdate={(event) => setT(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <div className="v12-pv-controls">
        <Tooltip name={playing ? "Pause" : "Play"}>
          <button type="button" className="v12-pv-ctl v12-pv-play" aria-label={playing ? "Pause" : "Play"} data-testid="v12-preview-play"
            onClick={() => { const el = video.current; if (!el) return; if (el.paused) void el.play().catch(() => {}); else el.pause(); }}>{playing ? "❚❚" : "▶"}</button>
        </Tooltip>
        <Tooltip name="One frame back">
          <button type="button" className="v12-pv-ctl" aria-label="One frame back" onClick={() => { video.current?.pause(); set(stepFrame(t, duration, -1)); }}>‹</button>
        </Tooltip>
        <Tooltip name="One frame forward">
          <button type="button" className="v12-pv-ctl" aria-label="One frame forward" onClick={() => { video.current?.pause(); set(stepFrame(t, duration, 1)); }}>›</button>
        </Tooltip>
        <input type="range" className="v12-pv-scrub" min={0} max={1000} value={duration > 0 ? Math.round((t / duration) * 1000) : 0} aria-label="Scrub" data-testid="v12-preview-scrub"
          onChange={(event) => { video.current?.pause(); set((Number(event.target.value) / 1000) * duration); }} />
        <span className="v12-pv-time" data-testid="v12-preview-time">{timeLabel(t, duration)}</span>
      </div>
    </div>
  );
}

/** A sound with its waveform. The bars are drawn from the take's id, a shape and not an analysis of the file; the sound plays from its own player. */
function Sound({ src, seed }: { src: string | null; seed: string }) {
  const bars = useMemo(() => waveBars(seed), [seed]);
  return (
    <div className="v12-pv-sound">
      <div className="v12-pv-wave" aria-hidden="true" data-testid="v12-preview-wave">
        {bars.map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}
      </div>
      {src ? <audio className="v12-pv-audio" src={src} controls preload="metadata" /> : null}
    </div>
  );
}
