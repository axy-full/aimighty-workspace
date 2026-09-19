"use client";
import { PAGES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * `NN Label` tabs. A trailing 5px dot shows done (green) or in progress
 * (blue); done comes from `completed`, progress from a run on that page.
 */
export function StageTabs() {
  const { state, go, dispatch } = useWorkspace();
  const pages = PAGES[state.suite];
  return (
    <nav className="pxw-stages" aria-label="Pages" data-row="stages">
      {pages.map((p, i) => {
        const on = p.id === state.page;
        const done = Boolean(state.completed[p.id]);
        const progress = !done && state.run?.page === p.id && (state.run.status === "running" || state.run.status === "waiting");
        return (
          <button key={p.id} type="button" className="pxw-stage" aria-current={on ? "page" : undefined} data-page={p.id} title={p.title} onClick={() => go(state.suite, p.id)}>
            <span className="pxw-stage-num" data-functional-label="">{String(i + 1).padStart(2, "0")}</span>
            <span className="pxw-stage-label">{p.label}</span>
            {done || progress ? (
              <span className="pxw-dot" style={{ background: progress ? "var(--pxw-blue-ink)" : "var(--pxw-green)" }} aria-label={progress ? "In progress" : "Complete"} />
            ) : null}
          </button>
        );
      })}
      <span className="pxw-stage-divider" aria-hidden="true" />
      <button type="button" className="pxw-stage-atomik" aria-expanded={state.agentOpen} onClick={() => dispatch({ type: "patch", patch: { agentOpen: true } })}>
        <span className="pxw-stage-atomik-star" aria-hidden="true">✦</span>
        <span className="pxw-stage-atomik-label">Atomik</span>
      </button>
    </nav>
  );
}
