"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Fault } from "@/components/Boundary";
import LazyMedia from "@/components/LazyMedia";
import { ACTION_LABEL, moving, priceLabel, trayWhen, type TrayJob } from "@/lib/jobsTray";
import { Glyph } from "./icons";
import { SAY } from "@/lib/shell/assets";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { handTakeToTakes } from "@/lib/shell/take-handover";
import { useJobsTray, type JobsTrayState, type RowProblem } from "@/lib/shell/use-jobs-tray";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * The header's jobs pill and its tray (a popover on desktop and on a phone on
 * its side, a bottom sheet on a phone): every take this person has rendering,
 * waiting, held or just finished, from any page and either engine — its real
 * stage, how long it has been going or when it finished, the ledger's figure,
 * and the one thing to do about it.
 */
const KIND_TAG: Record<TrayJob["kind"], string> = { video: "VID", image: "IMG", audio: "AUD", other: "•••" };

export function JobsPill() {
  const tray = useJobsTray();
  const anchor = useRef<HTMLButtonElement>(null);
  if (!tray) return null;
  const { summary } = tray;
  /* Nothing at all, or stopped (the account changed in another tab: the last count is not this account's to show). */
  if (((!summary && !tray.error) || tray.stopped) && !tray.open) return null;
  const unread = !summary && Boolean(tray.error);
  const quiet = !summary || summary.kind === "quiet";
  return (
    <>
      <button ref={anchor} type="button" className="gx-hbtn gx-jobs" data-tone={unread ? "red" : summary?.tone ?? "idle"} data-kind={summary?.kind ?? "quiet"}
        aria-haspopup="dialog" aria-expanded={tray.open} aria-label={unread ? "Jobs could not be read. Open to try again." : quiet ? "Jobs" : `Jobs: ${summary.text}`}
        onClick={() => tray.setOpen(!tray.open)} data-testid="running-jobs">
        <span className="gx-jobs-dot" aria-hidden="true" />
        <span className="gx-jobs-long" aria-hidden="true">{unread ? "Jobs · Try again" : quiet ? "Jobs" : summary.text}</span>
        {/* Short of room, nothing new says itself as the jobs glyph alone. */}
        <span className="gx-jobs-short" aria-hidden="true">{quiet ? <Glyph name="stack" size={16} className="gx-glyph" /> : summary.short}</span>
      </button>
      {tray.open ? <JobsTray tray={tray} anchor={anchor} /> : null}
    </>
  );
}

/** The pill's place when the tray itself fails to draw (components/Boundary): the header stays, and says so. */
export function JobsFault({ fault }: { fault: Fault }) {
  return (
    <button type="button" className="gx-hbtn gx-jobs" data-tone="red" onClick={() => { if (!fault.pending) fault.retry(); }} aria-disabled={fault.pending || undefined}
      aria-label={`The jobs tray could not be shown. ${fault.pending ? "Trying…" : "Try again"}`} data-testid="jobs-fault">
      <span className="gx-jobs-dot" aria-hidden="true" />
      <span className="gx-jobs-long" aria-hidden="true">{fault.pending ? "Jobs · Trying…" : "Jobs · Try again"}</span>
      <span className="gx-jobs-short" aria-hidden="true">{fault.pending ? "Trying…" : "Try again"}</span>
    </button>
  );
}

function useAnchor(anchor: RefObject<HTMLElement | null>) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setAt({ top: Math.round(rect.bottom + 8), right: Math.max(12, Math.round(window.innerWidth - rect.right)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  return at;
}

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
/** A dialog that says it is modal keeps Tab inside it: past the last control is the first, and back. */
function keepFocus(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const inside = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length);
  if (!inside.length) { e.preventDefault(); return; }
  const first = inside[0], last = inside[inside.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || at === e.currentTarget)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

function JobsTray({ tray, anchor }: { tray: JobsTrayState; anchor: RefObject<HTMLButtonElement | null> }) {
  const shell = useShell();
  const at = useAnchor(anchor);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { tray.setOpen(false); anchor.current?.focus(); };
  useEffect(() => { panel.current?.focus(); }, []);
  const { jobs, summary } = tray;
  const head = jobs.length ? (summary && summary.kind !== "quiet" ? summary.text : "Nothing running") : tray.status === "loading" ? "Reading…" : "";
  const style = at ? ({ "--jobs-top": `${at.top}px`, "--jobs-right": `${at.right}px` } as React.CSSProperties) : undefined;
  /* Out of the header island: a `backdrop-filter` ancestor would contain the fixed veil. */
  return createPortal(
    <div className="gx-veil gx-jobs-veil" onClick={close} data-testid="jobs-veil">
      <div ref={panel} className="gx-sheet gx-jobs-tray" role="dialog" aria-modal="true" aria-label="Jobs" tabIndex={-1} style={style}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } else keepFocus(e); }} data-testid="jobs-tray">
        <div className="gx-sheet-head gx-jobs-head">
          <span className="gx-panel-title">Jobs</span>
          {head ? <span className="gx-jobs-count" data-testid="jobs-summary">{head}</span> : null}
          <span className="gx-spacer" />
          <button type="button" className="gx-hbtn" onClick={close} data-testid="jobs-close">Close</button>
        </div>
        <div className="gx-sheet-list gx-scroll gx-jobs-list" data-testid="jobs-list">
          {/* A failed read keeps the last rows (or says so over none) and is asked again on its own; Try again asks at once. Said first, above the rows it is about. */}
          {tray.error ? (
            <div className="gx-jobs-note" role="alert" data-testid="jobs-error">
              <span>{tray.error}</span>
              {tray.stopped ? null : <button type="button" className="gx-hbtn gx-jobs-retry" onClick={tray.refresh} data-testid="jobs-retry">Try again</button>}
            </div>
          ) : null}
          {tray.partial ? <p className="gx-jobs-note" role="status" data-testid="jobs-partial">Connected-account jobs could not be read just now. They show again on the next read.</p> : null}
          {jobs.length ? (
            <ul className="gx-jobs-rows" aria-label="Jobs">
              {jobs.map((job) => <JobRow key={job.id} job={job} tray={tray} problem={tray.problems[job.id] ?? null} onDone={() => tray.setOpen(false)} />)}
            </ul>
          ) : tray.error ? null : tray.status === "loading" ? (
            <p className="gx-empty gx-jobs-empty" data-testid="jobs-loading" aria-busy="true">Reading your jobs…</p>
          ) : (
            <div className="gx-empty gx-jobs-empty" data-testid="jobs-empty">
              <p>Nothing is rendering or waiting, and nothing finished in the last 6 hours.</p>
              <button type="button" className="gx-hbtn gx-jobs-act--primary" onClick={() => { tray.setOpen(false); shell.goGen(); }} data-testid="jobs-generate">Generate</button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.querySelector(".gx") ?? document.body,
  );
}

function JobRow({ job, tray, problem, onDone }: { job: TrayJob; tray: JobsTrayState; problem: RowProblem | null; onDone: () => void }) {
  const shell = useShell();
  const ws = useWorkspace();
  const session = useSession();
  const openProject = ws.state.projectId;
  const where = job.projectName && job.draftId !== openProject ? job.projectName : null;
  const price = priceLabel(job.price);
  const busy = tray.releasing.has(job.id);

  /* The take's own project first, when it is not the one open. */
  const toProject = () => {
    if (!job.draftId || job.draftId === openProject) return;
    try { if (session.requestScope) localStorage.setItem(session.requestScope, job.draftId); } catch { /* the URL still carries it */ }
    ws.selectProject(job.draftId, { replace: true });
  };
  const act = () => {
    if (problem?.topUp) { shell.goWorkspace("credits"); onDone(); return; }
    switch (job.action) {
      case "open":
        toProject();
        /* That take and no other: Takes opens on it, and says so while it is found. */
        if (job.takeId) { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: job.takeId } }); handTakeToTakes(job.takeId); }
        shell.goSuite("studio", "takes"); onDone(); return;
      case "gen": toProject(); if (shell.view === "gen") shell.closePanels(); else shell.goGen(); onDone(); return;
      case "ads": toProject(); shell.goSuite("business", "ads"); onDone(); return;
      case "viral": toProject(); shell.goSuite("viral", "history"); onDone(); return;
      case "release": void tray.release(job); return;
      case "recreate": {
        if (!job.preset) return;
        /* Gen is handed the take's own recipe (lib/shell/recipe, as the Library's Recreate builds it); it is priced again before anything runs. */
        toProject();
        sendGenPreset(job.preset);
        if (shell.view === "gen") shell.closePanels(); else shell.goGen();
        ws.toast(SAY.recreate(job.name));
        onDone();
      }
    }
  };
  /* Release carries the figure it approves: the one approved when it was held, or a new one the route named. */
  const releaseAt = job.action === "release" ? problem?.credits ?? job.releaseCredits ?? null : null;
  const label = problem?.topUp ? "Top up" : releaseAt ? `Release · ${releaseAt.toLocaleString("en-US")}\u00a0cr` : job.action ? ACTION_LABEL[job.action] : null;
  return (
    <li className="gx-jobs-row" data-stage={job.stage} data-tone={job.tone} data-source={job.source} data-testid="jobs-row" data-job={job.id}>
      <span className="gx-jobs-thumb" aria-hidden="true">
        {job.mediaUrl && (job.kind === "image" || job.kind === "video") ? <LazyMedia url={job.mediaUrl} kind={job.kind} alt="" name={job.name} /> : <span className="gx-jobs-kind">{KIND_TAG[job.kind]}</span>}
      </span>
      <span className="gx-jobs-body">
        <span className="gx-jobs-name" title={where ? `${job.name} · ${where}` : job.name}>{job.name}</span>
        {/* The stage, how long it has been going (or when it finished), and the figure — each whole: a figure is never cut short. */}
        <span className="gx-jobs-meta">
          <span className="gx-jobs-stage" data-testid="jobs-stage">{job.label}</span>
          <span className="gx-jobs-when" data-testid="jobs-when">{trayWhen(job, tray.now)}</span>
          {price ? <span className="gx-jobs-price" data-testid="jobs-price">{price}</span> : null}
        </span>
        {where ? <span className="gx-jobs-where" data-testid="jobs-where">{where}</span> : null}
        {job.progress != null ? (
          <span className="gx-jobs-ring" role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} style={{ "--p": job.progress } as React.CSSProperties}>{Math.round(job.progress * 100)}%</span>
        ) : moving(job) ? <span className="gx-jobs-bar" role="progressbar" aria-label={job.label} data-testid="jobs-bar" /> : null}
        {job.reason ? <span className="gx-jobs-reason" data-testid="jobs-reason">{job.reason}</span> : null}
        {problem ? <span className="gx-jobs-problem" role="status" data-testid="jobs-problem">{problem.message}</span> : null}
      </span>
      {label ? (
        <button type="button" className={`gx-hbtn gx-jobs-act${job.action === "release" && !problem?.topUp ? " gx-jobs-act--primary" : ""}`} onClick={act} disabled={busy}
          aria-label={`${label}: ${job.name}`} data-testid="jobs-action">{busy ? "Releasing…" : label}</button>
      ) : null}
    </li>
  );
}
