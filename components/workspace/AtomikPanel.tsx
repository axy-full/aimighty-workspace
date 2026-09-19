"use client";
import { agentDot } from "@/lib/workspace/next";
import { getSuite, pageDef } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { Kicker } from "./ui";

/**
 * The Atomik panel frame: fixed top 58 / right 14, 396px, with a click
 * catcher behind it. The plan, steps, gate and activity arrive with the run
 * engine; until then it names the page's plan when one is registered and
 * never animates progress.
 */
export function AtomikPanel() {
  const { state, dispatch, plans } = useWorkspace();
  if (!state.agentOpen) return null;
  const close = () => dispatch({ type: "patch", patch: { agentOpen: false } });
  const plan = plans(state.page);
  const def = pageDef(state.page);
  const run = state.run && state.run.page === state.page ? state.run : null;
  const status = run?.status === "waiting" ? "WAITING ON YOU" : run?.status === "running" ? "RUNNING" : run?.status === "done" ? "DONE" : "IDLE";
  return (
    <div>
      <div className="pxw-catcher" onClick={close} aria-hidden="true" />
      <section className="pxw-atomik-panel" role="dialog" aria-label="Atomik">
        <div className="pxw-atomik-panel-head">
          <span className="pxw-dot" style={{ background: agentDot(state) }} aria-hidden="true" />
          <span className="pxw-atomik-panel-name">ATOMIK</span>
          <span className="pxw-atomik-panel-state" data-functional-label="">{status}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="pxw-atomik-close" aria-label="Close Atomik" onClick={close}>×</button>
        </div>
        <div className="pxw-atomik-panel-body">
          <Kicker>{`${getSuite(state.suite).short} · ${def.title}`}</Kicker>
          <div className="pxw-atomik-plan-title">{plan?.title ?? def.title}</div>
          <p className="pxw-atomik-plan-line">
            {plan
              ? plan.runnable === false ? "Not runnable yet." : "Review the steps and the price before anything runs."
              : "No plan is available for this page yet."}
          </p>
        </div>
      </section>
    </div>
  );
}
