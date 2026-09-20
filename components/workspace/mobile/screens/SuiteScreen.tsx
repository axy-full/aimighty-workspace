"use client";
import type { Project } from "@/lib/workbench/studio";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentStateLabel } from "@/lib/workspace/atomik-view";
import { avatarGradient, formatCount, initialsOf } from "@/lib/workspace/format";
import { agentDot, nextSentence } from "@/lib/workspace/next";
import { getSuite, PAGES } from "@/lib/workspace/pages";
import { PAGE_STATE_COLOR, PAGE_STATE_LABEL, pageStateOf, suiteProgress } from "@/lib/workspace/progress";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import { MobileRing, RING } from "../MobileRing";

/**
 * Suite (05-mobile, "Suite"): the project card, the Atomik next-action card,
 * then the suite's pages as 62px rows. Every figure is derived — the stage
 * count from lib/workspace/progress.ts (the same states the project card
 * reads), the Atomik sentence from lib/workspace/next.ts, the row counts from
 * the loaded lists. A row whose count the workspace does not hold shows none.
 */
export function SuiteScreen({ project }: { project: Project | null }) {
  const ws = useWorkspace();
  const { state } = ws;
  const atomik = useAtomik();
  const suite = getSuite(state.suite);
  const pages = PAGES[state.suite];
  const progress = suiteProgress(state, state.suite);
  const run = atomik.runFor(state.page);
  const plan = ws.plans(state.page);
  const waiting = run?.status === "waiting";
  const beating = run?.status === "running" || waiting || Boolean(state.gen);
  const name = project?.name ?? (state.projectId ? "" : "No project open");

  const countFor = (id: PageId): string | null => {
    if (id === "rig") return state.lists.shots ? formatCount(state.lists.shots.length) : null;
    if (id === "takes") return state.lists.takes ? formatCount(state.lists.takes.length) : null;
    if (id === "cast") return state.lists.cast ? formatCount(state.lists.cast.length) : null;
    return null;
  };

  return (
    <div data-screen="suite">
      <div className="pxm-pad-x pxm-pad-top">
        <div className="pxm-card">
          <div className="pxm-row">
            <span className="pxm-project-avatar" style={{ background: project ? avatarGradient(project.id) : "var(--pxw-avatar)" }} aria-hidden="true">
              {project ? initialsOf(project.name) : ""}
            </span>
            <span className="pxm-grow">
              <span className="pxm-project-name" data-testid="mobile-project-name">{name}</span>
              {project?.description ? <span className="pxm-project-meta">{project.description}</span> : null}
            </span>
          </div>
          {project?.aspect || project?.fps ? (
            <div className="pxm-chips">
              {project?.aspect ? <span className="pxm-chip">{project.aspect}</span> : null}
              {project?.fps ? <span className="pxm-chip">{project.fps} fps</span> : null}
            </div>
          ) : null}
          <div className="pxm-progress-row">
            <span className="pxm-progress-count">{formatCount(progress.done)}</span>
            <span className="pxm-progress-note" data-testid="mobile-stage-count">
              of {formatCount(progress.total)} {state.suite === "particl" ? "stages complete" : "tools configured"}
            </span>
          </div>
          <span className="pxm-bar" aria-hidden="true">
            <span className="pxm-bar-fill pxm-bar-blue" style={{ width: `${progress.pct}%` }} />
          </span>
        </div>
      </div>

      <button type="button" className="pxm-next" data-waiting={waiting ? "" : undefined} data-testid="mobile-atomik-card" onClick={() => ws.setSheet("atomik")}>
        <span className="pxm-next-inner">
          <MobileRing size={RING.card} beating={beating} color={agentDot(state)} />
          <span className="pxm-grow">
            <span className="pxm-next-kicker" data-functional-label="">ATOMIK · {run ? agentStateLabel(run) : "READY"}</span>
            <span className="pxm-next-line">{nextSentence(state, plan)}</span>
          </span>
          <span className="pxm-chevron" aria-hidden="true">›</span>
        </span>
      </button>

      <div className="pxm-section-head">
        <span className="pxm-kicker" data-functional-label="">{state.suite === "particl" ? "STAGES" : "TOOLS"}</span>
        <span className="pxm-kicker" data-functional-label="">{formatCount(pages.length)}</span>
      </div>

      <div className="pxm-pad-x pxm-rows">
        {pages.map((p, i) => {
          const pageState = pageStateOf(state, p.id);
          const on = p.id === state.page;
          const count = countFor(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className="pxm-stage-row"
              data-page={p.id}
              data-state={pageState}
              data-on={on ? "" : undefined}
              onClick={() => ws.go(state.suite, p.id)}
            >
              <span className="pxm-stage-mark" aria-hidden="true">{pageState === "done" ? "✓" : formatCount(i + 1)}</span>
              <span className="pxm-grow">
                <span className="pxm-stage-name">{p.title}</span>
                <span className="pxm-row pxm-stage-state">
                  <span className="pxm-dot5" style={{ background: PAGE_STATE_COLOR[pageState] }} aria-hidden="true" />
                  <span className="pxm-stage-state-label">{PAGE_STATE_LABEL[pageState]}</span>
                </span>
              </span>
              {count ? <span className="pxm-stage-count" data-functional-label="">{count}</span> : null}
              <span className="pxm-chevron" aria-hidden="true">›</span>
            </button>
          );
        })}
      </div>
      <p className="pxm-foot-note">{suite.desc}</p>
    </div>
  );
}
