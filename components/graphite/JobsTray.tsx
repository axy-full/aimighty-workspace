"use client";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import LazyMedia from "@/components/LazyMedia";
import { ACTION_LABEL, inFlight, priceLabel, trayAge, type TrayJob } from "@/lib/jobsTray";
import { SAY, retryPreset } from "@/lib/shell/assets";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { useJobsTray, type JobsTrayState, type RowProblem } from "@/lib/shell/use-jobs-tray";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * The header's jobs pill and its tray (a popover on desktop, a bottom sheet on
 * a phone): every take this person has rendering, held or just finished, from
 * any page and either engine — its real stage, how long it has been going,
 * the approved price, and the one thing to do about it.
 */
const KIND_TAG: Record<TrayJob["kind"], string> = { video: "VID", image: "IMG", audio: "AUD", other: "•••" };

export function JobsPill() {
  const tray = useJobsTray();
  const anchor = useRef<HTMLButtonElement>(null);
  /* Stopped (the account changed in another tab): the last count is not this account's to show. */
  if (!tray || ((!tray.summary || tray.stopped) && !tray.open)) return null;
  const summary = tray.summary;
  const text = summary?.text ?? "Jobs";
  return (
    <>
      <button ref={anchor} type="button" className="gx-hbtn gx-jobs" data-tone={summary?.tone ?? "idle"} aria-haspopup="dialog" aria-expanded={tray.open}
        aria-label={summary ? `Jobs: ${text}` : "Jobs"} onClick={() => tray.setOpen(!tray.open)} data-testid="running-jobs">
        <span className="gx-jobs-dot" aria-hidden="true" />
        <span className="gx-jobs-long" aria-hidden="true">{text}</span>
        <span className="gx-jobs-short" aria-hidden="true">{summary?.short ?? "Jobs"}</span>
      </button>
      {tray.open ? <JobsTray tray={tray} anchor={anchor} /> : null}
    </>
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

function JobsTray({ tray, anchor }: { tray: JobsTrayState; anchor: RefObject<HTMLButtonElement | null> }) {
  const shell = useShell();
  const at = useAnchor(anchor);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => { tray.setOpen(false); anchor.current?.focus(); };
  useEffect(() => { panel.current?.focus(); }, []);
  const { jobs, summary } = tray;
  const style = at ? ({ "--jobs-top": `${at.top}px`, "--jobs-right": `${at.right}px` } as React.CSSProperties) : undefined;
  /* Out of the header island: a `backdrop-filter` ancestor would contain the fixed veil. */
  return createPortal(
    <div className="gx-veil gx-jobs-veil" onClick={close} data-testid="jobs-veil">
      <div ref={panel} className="gx-sheet gx-jobs-tray" role="dialog" aria-modal="true" aria-label="Jobs" tabIndex={-1} style={style}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }} data-testid="jobs-tray">
        <div className="gx-sheet-head gx-jobs-head">
          <span className="gx-panel-title">Jobs</span>
          <span className="gx-jobs-count" data-testid="jobs-summary">{summary?.text ?? (tray.status === "loading" ? "Reading…" : "Nothing running")}</span>
          <span className="gx-spacer" />
          <button type="button" className="gx-hbtn" onClick={close} data-testid="jobs-close">Close</button>
        </div>
        <div className="gx-sheet-list gx-scroll gx-jobs-list" data-testid="jobs-list">
          {jobs.length ? (
            <ul className="gx-jobs-rows" aria-label="Jobs">
              {jobs.map((job) => <JobRow key={job.id} job={job} tray={tray} problem={tray.problems[job.id] ?? null} onDone={() => tray.setOpen(false)} />)}
            </ul>
          ) : tray.error ? null : tray.status === "loading" ? (
            <p className="gx-empty gx-jobs-empty" data-testid="jobs-loading" aria-busy="true">Reading your jobs…</p>
          ) : (
            <div className="gx-empty gx-jobs-empty" data-testid="jobs-empty">
              <p>Nothing rendering. What you generate shows here until it lands in Takes.</p>
              <button type="button" className="gx-hbtn gx-jobs-act--primary" onClick={() => { tray.setOpen(false); shell.goGen(); }} data-testid="jobs-generate">Generate</button>
            </div>
          )}
          {/* A failed read keeps the last rows (or says so over none) and is asked again on its own; Try now asks at once. */}
          {tray.error ? (
            <div className="gx-jobs-note" role="alert" data-testid="jobs-error">
              <span>{tray.error}</span>
              {tray.stopped ? null : <button type="button" className="gx-hbtn gx-jobs-retry" onClick={tray.refresh} data-testid="jobs-retry">Try now</button>}
            </div>
          ) : null}
          {tray.partial ? <p className="gx-jobs-note" role="status" data-testid="jobs-partial">Connected-account jobs could not be read just now.</p> : null}
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
  /* A held row's label already names what it needs. */
  const price = job.stage === "held" ? null : priceLabel(job.price);
  const meta = [trayAge(job.createdAt, tray.now), price].filter(Boolean).join(" · ");
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
      case "open": toProject(); shell.goSuite("studio", "takes"); onDone(); return;
      case "business": toProject(); shell.goSuite("business"); onDone(); return;
      case "viral": toProject(); shell.goSuite("viral", "history"); onDone(); return;
      case "release": void tray.release(job.id); return;
      case "recreate": {
        const recipe = job.recipe;
        if (!recipe) return;
        /* Gen is handed the take's own words (and settings, where Particl made it); it is priced again before anything runs. */
        if (recipe.connected) {
          sendGenPreset({ prompt: recipe.prompt, model: recipe.model, type: recipe.kind === "image" || recipe.kind === "audio" ? recipe.kind : "video", billing: "connected", references: [], note: `Retry · ${job.name} · prompt only` });
          ws.toast(SAY.retry(job.name, "prompt only"));
        } else {
          const preset = retryPreset(recipe);
          sendGenPreset(preset);
          ws.toast(SAY.retry(job.name, preset.kept));
        }
        toProject();
        shell.goGen();
        onDone();
      }
    }
  };
  const label = problem?.topUp ? "Top up" : job.action ? ACTION_LABEL[job.action] : null;
  return (
    <li className="gx-jobs-row" data-stage={job.stage} data-tone={job.tone} data-source={job.source} data-testid="jobs-row" data-job={job.id}>
      <span className="gx-jobs-thumb" aria-hidden="true">
        {job.mediaUrl && (job.kind === "image" || job.kind === "video") ? <LazyMedia url={job.mediaUrl} kind={job.kind} alt="" name={job.name} /> : <span className="gx-jobs-kind">{KIND_TAG[job.kind]}</span>}
      </span>
      <span className="gx-jobs-body">
        <span className="gx-jobs-name" title={where ? `${job.name} · ${where}` : job.name}>{job.name}</span>
        <span className="gx-jobs-meta">
          <span className="gx-jobs-stage" data-testid="jobs-stage">{job.label}</span>
          {meta ? <span className="gx-jobs-when"> · {meta}</span> : null}
        </span>
        {where ? <span className="gx-jobs-where" data-testid="jobs-where">{where}</span> : null}
        {job.progress != null ? (
          <span className="gx-jobs-ring" role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} style={{ "--p": job.progress } as React.CSSProperties}>{Math.round(job.progress * 100)}%</span>
        ) : inFlight(job) ? <span className="gx-jobs-bar" role="progressbar" aria-label={job.label} data-testid="jobs-bar" /> : null}
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
