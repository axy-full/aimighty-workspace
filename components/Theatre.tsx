"use client";

/**
 * The theatre: one render, full size, with everything known about it on the
 * side — the prompt as it was typed, what it cost, who made it, and the
 * sign-off. Arrow keys walk the wall; Escape leaves. Rendered through a
 * portal so no screen's transform can pin it in place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LockedTaskId } from "@/lib/tasks";
import { createPortal } from "react-dom";
import type { Gen } from "./GenCard";
import Review from "./Review";
import { ParticlSpinner } from "./ParticlMark";
import { appConfirm, appPrompt, appAlert } from "./dialog";
import { renameClip } from "./ContextMenu";
import { useUploadFile } from "@/lib/useUploadFile";
import { useSession } from "@/lib/session";
import { useProject } from "@/lib/projectContext";
import { usd, timeAgo, downloadHref, compactTokens } from "@/lib/format";
import { shortLabel } from "@/lib/models";
import { prettyModel } from "@/lib/models";
import { IconClose, IconArrowLeft, IconArrowRight, IconDown, IconTrash, IconCopy, IconAudio } from "./Icons";
import { stepFrame, timecode, FPS } from "@/lib/transport";
import { stripFor, stripIndex, neighbour } from "@/lib/filmstrip";
import LazyMedia from "./LazyMedia";
import { useIsMobile } from "@/lib/useMobile";
import { useMoney } from "@/lib/price";
import { failureKind, failureCopy } from "@/lib/jobState";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { castThumbs } from "@/lib/castUsage";

const clipId = (id: string) => id.split("_").pop()!.slice(-6).toUpperCase();

export default function Theatre({
  gens, activeId, onClose, onSelect, onChanged, onUse, onUseAsRef, onEditExtend, onStillTool, onRetry,
}: {
  gens: Gen[];
  activeId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onChanged: () => void;
  /** Load this render's prompt into the composer. */
  onUse?: (gen: Gen) => void;
  /** Carry this render into the composer as a REFERENCE rather than a prompt. */
  onUseAsRef?: (gen: Gen) => void;
  /** Start an edit or extension from this render. */
  onEditExtend?: (task: LockedTaskId, gen: Gen) => void;
  /** A still post tool (outpaint to an aspect, or a cutout), confirmed with its price by the caller. */
  onStillTool?: (tool: "outpaint" | "cutout", gen: Gen, ratio?: string) => void;
  /** Render this take again with its own parameters (brief 1.5). */
  onRetry?: (gen: Gen) => void;
}) {
  const idx = gens.findIndex((g) => g.id === activeId);
  const uploadFile = useUploadFile();
  const { requestScope } = useSession();
  const gen = idx >= 0 ? gens[idx] : null;
  /* Every take on this shot, under the player (§10 4.3). Derived from the
     rows already in the browser — a Gen carries its shotId — so opening a
     take does not cost a round trip to be told what it already knows. */
  const strip = stripFor(gens, gen);
  const here = stripIndex(strip, gen);
  /* With a strip on screen the arrows walk IT, not the wall behind it: a key
     that moves the highlight somewhere the eye cannot follow is worse than
     no key. Without one they walk the list the player was opened with,
     exactly as before. */
  const prev = neighbour(gens, strip, gen, -1);
  const next = neighbour(gens, strip, gen, 1);
  /* The cast behind the cited names, for the consistency check (brief 2.4). Asked only when a name was cited. */
  const citedCast = ((gen?.params as { cast?: string[] } | undefined)?.cast ?? []);
  const { data: castList } = useApi<{ cast: { name: string; uploadId: string | null }[] }>(citedCast.length ? "/api/cast?projectId=all" : null, 0);
  const [copied, setCopied] = useState(false);
  const [copiedErr, setCopiedErr] = useState(false);
  const [saveMenu, setSaveMenu] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const { selection } = useProject();
  const money = useMoney();
  const projectScope = selection !== "all" && selection !== "unfiled" ? selection : null;

  const video = useRef<HTMLVideoElement>(null);
  /* THE PLAYER IS THE APP'S ON DESKTOP (§10 4.3).
     It was one line — a bare <video controls> — so every verb 4.3 asks for
     (scrub, loop, in/out) lived in the browser's shadow DOM, where nothing
     in this product can reach it: not a keyboard binding, not a note that
     wants a position, not a second window. A control bar the app draws is
     the thing the rest of 4.3 is built on.
     On a phone the native bar stays: it carries fullscreen and
     picture-in-picture, which a producer watching on a handset actually
     wants and which this bar does not replace. */
  const mobile = useIsMobile();
  const [playing, setPlaying] = useState(true);
  const [at, setAt] = useState(0);
  const [span, setSpan] = useState(0);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(false);

  /* Position off the element itself, every frame. `timeupdate` fires about
     four times a second, which is fine for a number and visibly stuttery
     under a playhead. */
  useEffect(() => {
    if (mobile) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        setAt(v.currentTime);
        if (Number.isFinite(v.duration)) setSpan(v.duration);
        setPlaying(!v.paused);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mobile]);

  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => { /* the policy said no; the button shows it */ });
    else v.pause();
  }, []);
  useEffect(() => {
    if (!gen) return;
    const onKey = (e: KeyboardEvent) => {
      /* Typing a note must never walk the wall: arrows belong to the caret
         there. The PLAYER is deliberately no longer in this list. It used to
         be, and the cost was that the same key meant two things: click the
         native control bar once and the <video> holds focus, so every arrow
         after that was swallowed here and handled by the browser as a ±5s
         seek instead. Nothing on screen said which you would get. */
      /* A modal owns the keyboard while it is up. Without this, Escape
         closed the theatre out from under a confirm the person was still
         answering, and the arrows stepped frames behind it. */
      if (document.querySelector("[data-dialog]")) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('input,textarea,select,[contenteditable="true"]')) {
        if (e.key === "Escape") (t as HTMLElement).blur();
        return;
      }
      if (e.key === "Escape") { onClose(); return; }

      /* §10 4.2, all four arrows: ←/→ step a frame, ↑/↓ walk the takes. */
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const v = video.current;
        if (!v) return;
        e.preventDefault();
        // Stepping while it runs is meaningless — the next frame arrives on
        // its own. Asking for one frame is asking to stop on it.
        v.pause();
        v.currentTime = stepFrame(v.currentTime, Number.isFinite(v.duration) ? v.duration : null,
                                  e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (e.key === " " || e.code === "Space") {
        /* Space is how a focused BUTTON is pressed. Taking it here — the
           typing guard above lists fields, not buttons — meant nothing in
           the theatre, and nothing in a dialog raised from it, could be
           activated with the keyboard: `appConfirm` autofocuses Cancel, and
           Space did nothing to it while quietly pausing the video behind. */
        const el = e.target instanceof Element ? e.target : null;
        if (el?.closest('button, summary, [role="button"], [role="slider"]')) return;
        // Only where the app owns the transport; the native bar has its own.
        if (!mobile && video.current) { e.preventDefault(); toggle(); }
        return;
      }
      if (e.key === "ArrowUp" && prev) { e.preventDefault(); onSelect(prev.id); }
      else if (e.key === "ArrowDown" && next) { e.preventDefault(); onSelect(next.id); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [gen, prev, next, onClose, onSelect, mobile, toggle]);

  if (!gen || typeof document === "undefined") return null;

  const url = gen.storedUrl ?? gen.sourceUrl;
  const done = gen.status === "succeeded" && Boolean(url);
  const live = gen.status === "queued" || gen.status === "running";
  const still = gen.kind === "image";
  const p = gen.params as {
    resolution?: string; ratio?: string; duration?: number; seed?: number | string | null;
    rawPrompt?: string; cast?: string[];
  };
  const shown = p.rawPrompt || gen.prompt;
  const filing = gen.shotCode ? `${gen.shotCode} · v${gen.version ?? 1}` : clipId(gen.id);
  const title = gen.title || filing;

  async function rename() {
    await renameClip(gen!.id, gen!.title ?? "");
    onChanged();
  }

  /** The vendor's own words, verbatim, for pasting into a support thread. */
  async function copyError() {
    if (!gen?.error) return;
    try {
      await navigator.clipboard.writeText(gen.error);
      setCopiedErr(true);
      setTimeout(() => setCopiedErr(false), 1600);
    } catch { /* clipboard blocked — the text is selectable anyway */ }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — nothing sensible to do */ }
  }

  async function remove() {
    if (!(await appConfirm(`Delete ${clipId(gen!.id)}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
    await fetch(`/api/jobs/${gen!.id}`, { method: "DELETE" });
    onChanged();
    onClose();
  }

  /**
   * A still of this render, as a File: the PNG itself for a still, or the
   * frame the player is on for a video — drawn from a same-origin copy the
   * way the wall's posters are, so the canvas may read it.
   */
  async function frameFile(): Promise<File> {
    const base = url!;
    const src = `${base}${base.includes("?") ? "&" : "?"}stream=1`;
    if (still) {
      const blob = await (await fetch(src)).blob();
      return new File([blob], `${clipId(gen!.id)}.png`, { type: "image/png" });
    }
    const at = document.querySelector<HTMLVideoElement>(".theatre-media")?.currentTime ?? 0.1;
    const blob = await new Promise<Blob>((resolve, reject) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      const timer = setTimeout(() => reject(new Error("Couldn't read a frame from this render.")), 15_000);
      v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Couldn't read this render.")); }, { once: true });
      v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(Math.max(at, 0.05), Math.max(0.05, v.duration - 0.05)); }, { once: true });
      v.addEventListener("seeked", () => {
        clearTimeout(timer);
        try {
          const c = document.createElement("canvas");
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext("2d")!.drawImage(v, 0, 0);
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the frame."))), "image/png");
        } catch (e) { reject(e as Error); }
        finally { v.removeAttribute("src"); v.load(); }
      }, { once: true });
      v.src = src; v.load();
    });
    return new File([blob], `${clipId(gen!.id)}-frame.png`, { type: "image/png" });
  }

  /** This render becomes a character, a location, a prop or a look in the cast. */
  async function saveToCast(kind: "character" | "location" | "prop" | "style") {
    setSaveMenu(false);
    const what = kind === "style" ? "look" : kind;
    const name = await appPrompt(`Name this ${what}`, "", kind === "character" ? "e.g. Maya" : kind === "location" ? "e.g. HarbourSet" : kind === "prop" ? "e.g. RedHelmet" : "e.g. NoirLook");
    if (!name?.trim()) return;
    const description = await appPrompt("Describe it in a line", "", "what must stay the same, in a breath");
    if (description === null) return;
    setSaving("Capturing…");
    try {
      const f = await frameFile();
      setSaving("Uploading…");
      const up = await uploadFile(f, "reference", (pct) => setSaving(`Uploading ${pct}%`));
      const res = await fetch("/api/cast", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": requestScope ?? "visitor" },
        body: JSON.stringify({ name: name.trim(), kind, description, uploadId: up.id, projectId: gen!.projectId ?? projectScope }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't add it");
      await appAlert(`@${name.trim()} is in the cast`, "Write the name in any prompt and this frame comes with it.");
    } catch (e) {
      await appAlert("Couldn't save it", (e as Error).message);
    } finally { setSaving(null); }
  }

  return createPortal(
    <div className="theatre" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="theatre-stage" onClick={(e) => e.stopPropagation()}
        data-gen-id={gen.id} data-gen-prompt={gen.prompt} data-gen-label={gen.title || clipId(gen.id)}
        data-gen-title={gen.title ?? ""}>
        {done ? (
          still ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={gen.id} src={url!} alt={gen.prompt.slice(0, 120)} className="theatre-media" />
          ) : gen.kind === "audio" ? (
            <div className="theatre-face">
              <IconAudio className="!h-10 !w-10 text-white/70" />
              <p className="mt-3 max-w-[52ch] text-center text-[15px] text-white/90">{gen.title || gen.prompt.slice(0, 160)}</p>
              <audio key={gen.id} src={url!} controls autoPlay className="mt-4 w-[min(520px,90%)]" />
            </div>
          ) : (
            <video
              ref={video} key={gen.id} src={url!}
              controls={mobile} autoPlay playsInline
              loop={loop} muted={muted}
              className="theatre-media"
              onClick={mobile ? undefined : toggle}
            />
          )
        ) : (
          <div className="theatre-face">
            {gen.status === "held" ? (
              <>
                <p className="text-[15px] font-medium text-white/90">{(gen.params as { held?: { why?: string } }).held?.why === "slots" ? "Waiting for a slot" : "Held"}</p>
                <p className="mt-1 text-[13px] text-white/60">
                  {(gen.params as { held?: { why?: string } }).held?.why === "slots"
                    ? "It starts the moment a render lands."
                    : `Needs ${Number((gen.params as { held?: { needs?: number } }).held?.needs ?? 0)} credits. Top up to release it — nothing is lost.`}
                </p>
              </>
            ) : live ? (
              <>
                <ParticlSpinner size={34} className="text-white/80" />
                <p className="mt-3 text-[15px] font-medium text-white/90">{gen.status === "queued" ? "Queued" : "Rendering"}…</p>
                <p className="mt-1 text-[13px] text-white/60">It will appear here the moment it lands.</p>
              </>
            ) : (
              <>
                <p className="text-[15px] font-medium text-[#FF6B60]">{gen.status === "cancelled" ? "Cancelled" : "Failed"}</p>
                {gen.status === "failed" && (() => {
                  const f = failureCopy(failureKind(gen.error, gen.params));
                  return (
                    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                      <span className="text-[13px] text-white/80">{f.why}</span>
                      {f.action === "retry" && onRetry && <button type="button" className="chip !py-1 !text-[12.5px]" onClick={() => onRetry(gen)}>{f.label}</button>}
                      {f.action === "edit" && onUse && <button type="button" className="chip !py-1 !text-[12.5px]" onClick={() => onUse(gen)}>{f.label}</button>}
                      {f.action === "unlock" && gen.projectId && <Link href={`/projects/${encodeURIComponent(gen.projectId)}`} className="chip !py-1 !text-[12.5px]">{f.label}</Link>}
                      {f.action === "topup" && <Link href="/settings#credits" className="chip !py-1 !text-[12.5px]">{f.label}</Link>}
                    </div>
                  );
                })()}
                {gen.error && (
                  <>
                    {/* Monospace, selectable and scrollable: a vendor refusal
                        arrives as JSON carrying the error CODE, and the code is
                        the part that says which review refused it. Prose
                        styling made that unreadable and hard to copy exactly. */}
                    <pre className="mt-3 max-h-[38vh] max-w-[68ch] select-text overflow-auto whitespace-pre-wrap break-words rounded-[10px] bg-black/40 px-3 py-2.5 text-left font-mono text-[12px] leading-relaxed text-white/80">
                      {gen.error}
                    </pre>
                    <button type="button" onClick={copyError}
                      className="mt-2 rounded-full bg-white/10 px-3 py-1.5 text-[12.5px] font-medium text-white/80 transition-colors hover:bg-white/15">
                      {copiedErr ? "Copied" : "Copy the error"}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {!mobile && done && !still && gen.kind !== "audio" && (
          /* The transport, drawn by the app. Everything on it is something
             4.3 needs to be able to reach from somewhere else: a position a
             note can point at, a loop that can be turned off, a playhead a
             second window could mirror. */
          <div className="tbar" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="tbar-btn" onClick={toggle}
              aria-label={playing ? "Pause  space" : "Play  space"} title={playing ? "Pause  space" : "Play  space"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="tbar-tc mono-s" aria-live="off">{timecode(at)}</span>
            <input
              className="tbar-scrub" type="range" min={0} max={Math.max(0.04, span)} step={1 / FPS}
              value={Math.min(at, span || 0)} aria-label="Position in this take"
              aria-valuetext={`${timecode(at)} of ${timecode(span)}`}
              onChange={(e) => { const v = video.current; if (v) { v.currentTime = Number(e.target.value); setAt(Number(e.target.value)); } }}
            />
            <span className="tbar-tc mono-s text-dim">{timecode(span)}</span>
            <button type="button" className={`tbar-btn tbar-tog ${loop ? "is-on" : ""}`} aria-pressed={loop}
              onClick={() => setLoop((v) => !v)} title="Loop" aria-label="Loop">↺</button>
            <button type="button" className={`tbar-btn tbar-tog ${muted ? "is-on" : ""}`} aria-pressed={muted}
              onClick={() => setMuted((v) => !v)} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"}>
              {muted ? "🔇" : "🔊"}
            </button>
          </div>
        )}

        {!mobile && strip.length > 1 && (
          /* The strip. It counts what it shows rather than claiming to be
             every take that exists: opened from a shot-scoped wall it is all
             of them, opened from the library it is the ones on screen, and
             saying "3 takes" of something that is not exhaustive would be
             the kind of small lie a producer eventually catches. */
          <div className="fs" onClick={(e) => e.stopPropagation()}>
            <span className="fs-lbl mono-s">{gen.shotCode ?? "Shot"} · {strip.length} here</span>
            <div className="fs-row" role="listbox" aria-label={`Takes of ${gen.shotCode ?? "this shot"}`}>
              {strip.map((t, i) => {
                const on = i === here;
                const url = t.storedUrl ?? t.sourceUrl ?? null;
                return (
                  <button
                    key={t.id} type="button" role="option" aria-selected={on}
                    className={`fs-cell${on ? " is-on" : ""}`}
                    title={`v${t.version ?? i + 1}${on ? " — showing" : ""}`}
                    onClick={() => { if (!on) onSelect(t.id); }}
                  >
                    {url
                      ? <LazyMedia url={url} kind={t.kind === "image" ? "image" : "video"} alt="" className="fs-media" />
                      : <span className="fs-none" />}
                    <span className="fs-v mono-s">v{t.version ?? i + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {prev && (
          <button type="button" onClick={() => onSelect(prev.id)} className="theatre-nav theatre-prev" title="Previous take  ↑">
            <IconArrowLeft />
          </button>
        )}
        {next && (
          <button type="button" onClick={() => onSelect(next.id)} className="theatre-nav theatre-next" title="Next take  ↓">
            <IconArrowRight />
          </button>
        )}
      </div>

      <aside className="theatre-side" onClick={(e) => e.stopPropagation()}>
        <header className="theatre-head">
          <div className="min-w-0">
            <button type="button" onClick={rename} title={gen.title ? "Rename" : "Name this clip"}
              className="block max-w-full truncate text-left text-[16px] font-semibold tracking-[-0.01em] hover:text-blue">
              {title}
            </button>
            <p className="text-[12.5px] text-mute">
              {gen.title ? `${filing} · ` : ""}{gen.projectName ?? "Unfiled"}{gen.authorName ? ` · ${gen.authorName}` : ""} · {timeAgo(gen.createdAt)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="theatre-close" title="Close  Esc"><IconClose /></button>
        </header>

        <div className="theatre-body">
          <p className="theatre-prompt">{shown}</p>
          {p.cast && p.cast.length > 0 && (
            /* The consistency check (brief 2.4): the still that stands behind each cited name, beside the take, so a likeness drift shows at a glance. */
            <p className="mt-2 flex flex-wrap gap-1.5">
              {castThumbs(p.cast, castList?.cast ?? []).map((c) => (
                <span key={c.name} className="theatre-cast">
                  {c.uploadId && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={`/api/uploads/${c.uploadId}`} alt="" className="theatre-cast-still" />
                  )}
                  <span className="rounded-full bg-blue/10 px-2 py-0.5 text-[12px] font-medium text-blue">@{c.name}</span>
                </span>
              ))}
            </p>
          )}

          <div className="theatre-meta">
            <span className="font-medium text-dim">{shortLabel(gen.model)}</span>
            {p.resolution && <span>{String(p.resolution).toUpperCase()}</span>}
            {p.ratio && <span>{p.ratio === "adaptive" ? "Auto" : p.ratio}</span>}
            {p.duration != null && <span>{p.duration}s</span>}
            {p.seed != null && p.seed !== "" && <span>seed {p.seed}</span>}
            {(gen.params as { look?: { name?: string } }).look?.name && (
              <span className="rounded-full bg-chip px-2 py-0.5 text-[11.5px] font-medium text-dim">
                {(gen.params as { look: { name: string } }).look.name}
              </span>
            )}
            {/* Whichever unit this row carries — a credit workspace is sent
                creditsBilled and no dollars, and one on its own keys the
                reverse, so "is it priced" is the two together. */}
            {(gen.providerCreditQuote || gen.creditsBilled != null || gen.costUsd != null) && (
              <span className="font-semibold text-bone" title="Render plus prompt">
                {money.take(gen)}
              </span>
            )}
          </div>

          {/* The ledger for this one render: what the engine charged, what
              the writer charged, and the sum that appears everywhere else. */}
          {gen.creditsBilled != null && money.inCredits && (
            <div className="theatre-ledger">
              <span><span className="text-mute">Charged</span> {money.take(gen)}</span>
              <span className="text-mute">{gen.refineModel ? "prompt writing included" : "prompt as written"}</span>
            </div>
          )}
          {gen.costUsd != null && !money.inCredits && (
            <div className="theatre-ledger">
              <span><span className="text-mute">Engine</span> {usd(gen.costUsd)}</span>
              <span>
                <span className="text-mute">Prompt</span>{" "}
                {gen.refineCostUsd != null && gen.refineModel
                  ? <>{gen.refineCostUsd > 0 ? usd(gen.refineCostUsd) : "free"}<span className="text-mute"> · {prettyModel(gen.refineModel)}
                      {gen.refineInTokens != null ? ` · ${compactTokens(gen.refineInTokens)} in / ${compactTokens(gen.refineOutTokens ?? 0)} out` : ""}</span></>
                  : <span className="text-mute">as written</span>}
              </span>
              <span className="ml-auto font-semibold text-bone">{usd(gen.costUsd + (gen.refineCostUsd ?? 0))}</span>
            </div>
          )}

          <div className="theatre-actions">
            <button type="button" onClick={copy} className="chip !py-1.5 !text-[13px]">
              <IconCopy /> {copied ? "Copied" : "Copy prompt"}
            </button>
            {onUseAsRef && done && !still && gen.kind !== "audio" && (
              <button type="button" onClick={() => onUseAsRef(gen)} className="chip !py-1.5 !text-[13px]"
                title="Attach this clip to the next render">Use as reference</button>
            )}
            {onUseAsRef && done && still && (
              <button type="button" onClick={() => onUseAsRef(gen)} className="chip !py-1.5 !text-[13px]"
                title="Attach this still to the next render">Use as reference</button>
            )}
            {onStillTool && done && still && (
              <>
                {["9:16", "1:1", "4:5"].map((r) => (
                  <button key={r} type="button" onClick={() => onStillTool("outpaint", gen, r)} className="chip !py-1.5 !text-[13px]"
                    title={`Outpaint this still to ${r} with Bria — the new frame painted in`}>Outpaint {r}</button>
                ))}
                <button type="button" onClick={() => onStillTool("cutout", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Lift the subject off its background with Bria — transparent behind it">Cut out</button>
              </>
            )}
            {onUse && (
              <button type="button" onClick={() => onUse(gen)} className="chip !py-1.5 !text-[13px]" title="Load into the composer">
                Use
              </button>
            )}
            {onEditExtend && done && !still && (
              <>
                <button type="button" onClick={() => onEditExtend("edit", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Change something inside this shot; everything else stays">Edit</button>
                <button type="button" onClick={() => onEditExtend("extend", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Continue this shot from its final frame">Extend</button>
                <button type="button" onClick={() => onEditExtend("motion", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Give a still character this clip's movement — Kling 3.0 motion control">Motion</button>
                <button type="button" onClick={() => onEditExtend("upscale", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Re-render this clip at up to 4K with Topaz Astra">Upscale</button>
                <button type="button" onClick={() => onEditExtend("reframe", gen)} className="chip !py-1.5 !text-[13px]"
                  title="Re-cut this clip to another aspect — 9:16, 1:1 — with Luma Ray 2">Reframe</button>
              </>
            )}
            {done && (
              <span className="relative">
                <button type="button" onClick={() => setSaveMenu((v) => !v)} disabled={Boolean(saving)}
                  className="chip !py-1.5 !text-[13px] disabled:opacity-50" title="Keep this as a character, a location, a prop or a look">
                  {saving ?? "Save as…"}
                </button>
                {saveMenu && (
                  <span className="pop-surface absolute left-0 top-[calc(100%+6px)] z-10 block w-[220px]">
                    {([["character", "Character"], ["location", "Location"], ["prop", "Prop"], ["style", "Cast look"]] as const).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => saveToCast(k)} className="menu-item">{l}</button>
                    ))}
                  </span>
                )}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {url && (
                <a href={downloadHref(url)} download={`${clipId(gen.id)}.${still ? "png" : "mp4"}`} title="Download the master"
                  className="theatre-icon"><IconDown /></a>
              )}
              <button type="button" onClick={remove} title="Delete" className="theatre-icon hover:!text-lift"><IconTrash /></button>
            </span>
          </div>

          <Review key={gen.id} genId={gen.id} state={gen.reviewState ?? ""} reviewBy={gen.reviewBy ?? null}
            trail={{ pickedBy: gen.pickedBy ?? null, pickedAt: gen.pickedAt ?? null, approvedBy: gen.approvedBy ?? null, approvedAt: gen.approvedAt ?? null }}
            reason={(gen.params as { reason?: string }).reason ?? null} onChanged={onChanged} />
        </div>
      </aside>
    </div>,
    document.body
  );
}
