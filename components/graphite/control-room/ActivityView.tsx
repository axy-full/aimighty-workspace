"use client";
import { useCallback, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace/state";
import { openAtomikChat } from "@/lib/shell/use-skills";
import { prefillAgentRequest } from "@/lib/shell/agent-draft";
import { exact } from "@/lib/shell/price-words";
import { useActivity } from "@/lib/control-room/use-activity";
import {
  RUN_STATE_LABEL, filterRuns, runNumber, runStats, settledValue,
  type ActivityRun, type RunFilter, type RunStep,
} from "@/lib/control-room/activity";
import { UNBILLED, type Outcome } from "@/lib/control-room/queue";
import { LoadBanner } from "../TakeTile";
import { Price } from "../Price";
import { when } from "./words";

/**
 * Control room › Activity (Atomik frame h; README § 3.4): what every project
 * has settled, then this project's runs with what each settled, and a run's
 * steps in the Inspector. Read only: a run waiting for a person is approved in
 * Approvals, through each step's own route. Figures are the ledger's, in
 * credits; work in flight reads "settling" and has no figure until it settles
 * (lead decision 9: no held figure).
 */
export function ActivityView({ project, filter }: { project: Project | null; filter: RunFilter }) {
  const shell = useShell();
  const ws = useWorkspace();
  const session = useSession();
  const production = project?.productionProjectId ?? null;
  const activity = useActivity(production);
  const [openId, setOpenId] = useState<string | null>(null);
  const reply = activity.reply;
  const runs = reply?.runs ?? [];
  const shown = filterRuns(runs, filter);
  const stats = runStats(runs);
  const open = runs.find((r) => r.id === openId) ?? null;
  const inCredits = reply?.inCredits ?? true;

  const select = useCallback((draftId: string | null) => {
    if (draftId && draftId !== ws.state.projectId) ws.selectProject(draftId, { replace: true });
  }, [ws]);
  const openRun = useCallback((run: ActivityRun) => {
    const to = run.open;
    if (to.kind === "board") { select(to.draftId); shell.goSuite("studio", "rig"); return; }
    if (to.kind === "thread") { select(run.project.draftId); openAtomikChat({ chatId: to.chatId, projectId: to.productionId }); shell.goSuite("atomik", "agent"); }
  }, [select, shell]);
  /* Run again: the request goes back into Atomik's box, where its price shows before anything is spent. */
  const runAgain = useCallback((run: ActivityRun) => {
    const draft = run.project.draftId ?? project?.id ?? null;
    if (draft && run.request) prefillAgentRequest(session.requestScope, "atomik", draft, run.request);
    select(draft);
    shell.goSuite("atomik", "agent");
  }, [project, select, session.requestScope, shell]);

  return (
    <div className="cr-body cr-body--one" data-testid="activity">
      {activity.error ? <LoadBanner banner={{ tone: reply ? "stale" : "error", message: activity.error }} onRetry={activity.refresh} testId="activity-error" /> : null}
      {reply && reply.projects.length ? (
        <div className="cr-block" data-testid="settled-per-project">
          <span className="cr-eyebrow">Settled per project</span>
          <div className="cr-tiles">
            {reply.projects.map((p) => (
              <button key={p.project.productionId ?? "none"} type="button" className="cr-tile" data-current={p.project.productionId === production || undefined}
                onClick={() => select(p.project.draftId)} disabled={!p.project.draftId} data-testid="project-tile">
                <span className="cr-tile-name">{p.project.name ?? "A project"}</span>
                <span className="cr-figure"><Price value={exact(p.settled)} /> settled</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="cr-stats" data-testid="run-stats">
        <Stat k="Running" v={String(stats.running)} sub="settling step by step" />
        <Stat k="Needs you" v={String(stats.needsYou)} sub="at a gate in Approvals" tone="waiting" />
        <Stat k="Settled" v={inCredits ? <Price value={exact(stats.settled)} /> : UNBILLED} sub="this project · after confirmation" />
      </div>

      <div className={open ? "cr-runs cr-runs--open" : "cr-runs"}>
        <div className="cr-block" style={{ minWidth: 0 }}>
          <div className="cr-run cr-run--head" aria-hidden="true"><span>Run</span><span>Request</span><span>State</span><span className="cr-right">Settled</span><span /></div>
          {activity.status === "loading" && !reply ? <p className="cr-empty" role="status" aria-busy="true">Reading runs…</p>
            : shown.length ? (
              <ul className="cr-list" aria-label="Runs">
                {shown.map((run) => (
                  <li key={run.id}>
                    <div className="cr-run" data-state={run.state} data-current={run.id === openId || undefined} data-testid="run-row" data-run={run.id}
                      role="button" tabIndex={0} aria-expanded={run.id === openId} onClick={() => setOpenId(run.id === openId ? null : run.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(run.id === openId ? null : run.id); } }}>
                      <span className="cr-run-n">{runNumber(run.n)}</span>
                      <span className="cr-run-what">
                        <span className="cr-row-title">{run.title}</span>
                        <span className="cr-row-line">{[when(run.startedAt), run.source === "board" ? "Board" : "Atomik", `${paidSteps(run)} ${paidSteps(run) === 1 ? "step" : "steps"}`].join(" · ")}</span>
                      </span>
                      <span className="cr-run-state"><span className="cr-dot" data-tone={tone(run)} aria-hidden="true" />{RUN_STATE_LABEL[run.state]}</span>
                      <span className="cr-figure cr-right" data-tone={run.settled > 0 ? undefined : "quiet"}>{runFigure(run, inCredits)}</span>
                      <span className="cr-run-act">
                        {run.state === "needs-you"
                          ? <button type="button" className="cr-btn" onClick={(e) => { e.stopPropagation(); shell.goSuite("atomik", "approvals"); }} data-testid="run-approvals">Approvals ›</button>
                          : <button type="button" className="cr-btn" onClick={(e) => { e.stopPropagation(); openRun(run); }} data-testid="run-open">Open</button>}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="cr-empty" data-testid="runs-empty">No runs match. Every run this project has made is here, with what it settled at.</p>}
          <p className="cr-text">A run is a request to Atomik and the plan it made. A figure is what the ledger settled; a step still in flight settles when its take finishes.</p>
        </div>
        {open ? <RunInspector run={open} inCredits={inCredits} onClose={() => setOpenId(null)} onOpen={() => openRun(open)} onRunAgain={() => runAgain(open)}
          onSaveAsSkill={() => shell.goSuite("atomik", "saved-skills")} /> : null}
      </div>
    </div>
  );
}

const paidSteps = (run: ActivityRun) => run.steps.filter((s) => s.kind === "paid").length;
const tone = (run: ActivityRun) => (run.state === "done" ? "done" : run.state === "needs-you" || run.state === "failed" ? undefined : "quiet");

function runFigure(run: ActivityRun, inCredits: boolean) {
  if (!inCredits) return UNBILLED;
  const value = settledValue(run);
  if (value) return <><Price value={value} /> settled{run.settling ? " · settling" : ""}</>;
  if (run.settling) return "settling";
  /* "Nothing billed" only where the ledger confirms it for every step; otherwise no figure yet. */
  return run.steps.length && run.steps.every((s) => s.settled.kind === "nothing") ? "nothing billed" : "";
}

function Stat({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub: string; tone?: "waiting" }) {
  return (
    <div className="cr-stat">
      <span className="cr-eyebrow">{k}</span>
      <span className="cr-stat-v" data-tone={tone}>{v}</span>
      <span className="cr-count">{sub}</span>
    </div>
  );
}

function outcomeWords(o: Outcome) {
  return o.kind === "settled" ? <><Price value={exact(o.credits)} /> settled</>
    : o.kind === "settling" ? "settling"
    : o.kind === "nothing" ? "nothing billed"
    : o.kind === "unbilled" ? UNBILLED
    : null;
}

function stepLine(step: RunStep) {
  const by = step.auto ? "spent without asking" : step.byYou ? "approved by you" : step.by ? `approved by ${step.by}` : null;
  return [step.state === "done" || step.state === "approved" ? null : step.state, by, step.at ? when(step.at) : null].filter(Boolean).join(" · ");
}

/** The Inspector on a run: where it stands, every step priced and settled, and what to do with it. */
function RunInspector({ run, inCredits, onClose, onOpen, onRunAgain, onSaveAsSkill }: {
  run: ActivityRun; inCredits: boolean; onClose: () => void; onOpen: () => void; onRunAgain: () => void; onSaveAsSkill: () => void;
}) {
  return (
    <aside className="cr-inspector" aria-label={`Run ${runNumber(run.n)}`} data-testid="run-inspector">
      <div className="cr-block-head">
        <span className="cr-eyebrow">Run · {runNumber(run.n)}</span>
        <button type="button" className="cr-btn" onClick={onClose} data-testid="run-close">Close</button>
      </div>
      <span className="cr-row-title">{run.title}</span>
      <dl className="cr-facts">
        <dt>State</dt><dd>{RUN_STATE_LABEL[run.state]}{run.reason ? ` · ${run.reason}` : ""}</dd>
        <dt>Started</dt><dd>{when(run.startedAt)}</dd>
        <dt>Settled</dt><dd className="cr-figure">{runFigure(run, inCredits)}</dd>
      </dl>
      <span className="cr-eyebrow">Steps</span>
      <ol className="cr-list" data-testid="run-steps">
        {run.steps.map((step) => (
          <li key={step.id} className="cr-step" data-testid="run-step" data-kind={step.kind}>
            <span style={{ minWidth: 0 }}>
              <span className="cr-decided-title">{step.title}</span>
              <span className="cr-decided-line">{stepLine(step)}</span>
            </span>
            <span className="cr-figure cr-right">
              {step.priced ? <span className="cr-step-priced"><Price value={step.priced} /> → </span> : null}
              {outcomeWords(step.settled)}
            </span>
          </li>
        ))}
        {run.steps.length ? null : <li className="cr-empty">No steps yet.</li>}
      </ol>
      <div className="cr-row-actions">
        <button type="button" className="cr-btn" onClick={onOpen} data-testid="run-inspector-open">Open</button>
        {run.request ? <button type="button" className="cr-btn" onClick={onRunAgain} data-testid="run-again">Run again</button> : null}
        {run.source === "thread" && run.state === "done" ? <button type="button" className="cr-btn" onClick={onSaveAsSkill} data-testid="run-save-skill">Save as skill</button> : null}
      </div>
    </aside>
  );
}
