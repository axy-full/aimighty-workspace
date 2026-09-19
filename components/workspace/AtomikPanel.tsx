"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentStateLabel, priceText, runButton, stepRows } from "@/lib/workspace/atomik-view";
import { agentDot } from "@/lib/workspace/next";
import { getSuite, pageDef, suiteOfPage } from "@/lib/workspace/pages";
import { formatCredits } from "@/lib/workspace/run-engine";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import { Keycap, Kicker } from "./ui";

/**
 * The Atomik panel (04 "Panel"): fixed top 58 / right 14, 396px, over a
 * click catcher. Header → plan → steps from the real run engine → the gate
 * card with the live quote → price + run button → ACTIVITY.
 *
 * Nothing here animates: a step moves only when its backend call resolves.
 */
export function AtomikPanel() {
  const { state, dispatch, go } = useWorkspace();
  const atomik = useAtomik();
  if (!state.agentOpen) return null;
  const close = () => dispatch({ type: "patch", patch: { agentOpen: false } });

  const def = pageDef(state.page);
  const plan = atomik.plan(state.page);
  const run = atomik.runFor(state.page);
  const runnable = atomik.runnable(state.page);
  const button = runButton(run, runnable);
  const rows = plan ? stepRows(plan, run, atomik.ctx) : [];
  const waiting = run?.status === "waiting";
  const quote = run?.quote ?? null;
  const gatePrice = quote ? formatCredits(quote.credits, quote.unit) : null;
  /* A run held on another page stays reachable: an approval never hides. */
  const elsewhere = atomik.state.run && (!run || atomik.state.run.id !== run.id) && ["running", "waiting"].includes(atomik.state.run.status)
    ? atomik.state.run
    : null;
  const elsewherePage = elsewhere ? (elsewhere.page as PageId) : null;
  const dot = waiting ? "var(--pxw-amber)" : run?.status === "running" ? "var(--pxw-blue)" : agentDot(state);

  return (
    <div>
      <div className="pxw-catcher" onClick={close} aria-hidden="true" />
      <section className="pxw-atomik-panel" role="dialog" aria-label="Atomik" data-testid="atomik-panel">
        <div className="pxw-atomik-panel-head">
          <span className="pxw-dot" style={{ background: dot }} aria-hidden="true" />
          <span className="pxw-atomik-panel-name">ATOMIK</span>
          <span className="pxw-atomik-panel-state" data-functional-label="" data-testid="atomik-state">{agentStateLabel(run)}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="pxw-atomik-close" aria-label="Close Atomik" onClick={close}>×</button>
        </div>

        {elsewhere && elsewherePage ? (
          <button type="button" className="pxw-atomik-elsewhere" onClick={() => go(suiteOfPage(elsewherePage), elsewherePage)}>
            <span className="pxw-dot" style={{ background: elsewhere.status === "waiting" ? "var(--pxw-amber)" : "var(--pxw-blue)" }} aria-hidden="true" />
            <span>
              {pageDef(elsewherePage).title} {elsewhere.status === "waiting" ? "is waiting on your approval" : "is running"}
            </span>
            <span className="pxw-atomik-elsewhere-go">Open</span>
          </button>
        ) : null}

        <div className="pxw-atomik-panel-body">
          <Kicker>{`${getSuite(state.suite).short} · ${def.title}`}</Kicker>
          <div className="pxw-atomik-plan-title" data-testid="atomik-plan-title">{plan?.title ?? def.title}</div>
          <p className="pxw-atomik-plan-line">{plan ? plan.line : "No plan is available for this page."}</p>
          {plan && !runnable.ok && !run ? (
            <p className="pxw-atomik-reason" role="note" data-testid="atomik-reason">{runnable.reason}</p>
          ) : null}
        </div>

        {rows.length ? (
          <ol className="pxw-atomik-steps" aria-label="Steps">
            {rows.map((row, i) => (
              <li key={i} className="pxw-atomik-step" data-tone={row.tone} data-testid="atomik-step">
                <span className="pxw-atomik-mark" aria-hidden="true">{row.mark}</span>
                <span className="pxw-atomik-step-label">{row.label}</span>
                <span className="pxw-atomik-step-meta" data-gate={row.gate || undefined}>{row.meta}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {waiting ? (
          <div className="pxw-gate" role="group" aria-label="Approval required" data-testid="atomik-gate">
            <div className="pxw-gate-head">
              <span className="pxw-gate-title">Approval required</span>
              <span className="pxw-gate-price" data-testid="atomik-gate-price">{gatePrice ?? "—"}</span>
            </div>
            {quote ? <div className="pxw-gate-line">{quote.line}</div> : null}
            {run?.notice ? <div className="pxw-gate-notice" role="status">{run.notice}</div> : null}
            {run?.quoting ? <div className="pxw-gate-notice" role="status">Getting a fresh quote…</div> : null}
            <div className="pxw-gate-actions">
              <button type="button" className="pxw-gate-decline" onClick={atomik.decline} disabled={run?.approved}>Not now</button>
              <button
                type="button"
                className="pxw-gate-approve"
                disabled={!quote || run?.quoting}
                onClick={() => void atomik.approve()}
              >
                Approve {gatePrice ?? ""}
              </button>
            </div>
          </div>
        ) : null}

        {run?.status === "failed" && run.error ? (
          <div className="pxw-atomik-error" role="alert">{run.error}</div>
        ) : null}
        {atomik.state.notice && !run ? (
          <div className="pxw-atomik-error" role="alert">{atomik.state.notice}</div>
        ) : null}

        {plan ? (
          <div className="pxw-atomik-foot">
            <span className="pxw-atomik-price" data-paid={plan.paid || undefined} data-testid="atomik-price">{priceText(plan, run)}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="pxw-atomik-run"
              data-busy={button.busy || undefined}
              disabled={button.disabled}
              title={!runnable.ok ? runnable.reason : undefined}
              onClick={() => atomik.start(state.page)}
            >
              <span>{button.label}</span>
              <Keycap className="pxw-atomik-run-key" aria-hidden="true">A</Keycap>
            </button>
          </div>
        ) : null}

        <div className="pxw-activity" data-testid="atomik-activity">
          <Kicker>Activity</Kicker>
          {atomik.activity.length ? (
            atomik.activity.map((entry) => (
              <div className="pxw-activity-row" key={entry.id}>
                <span className="pxw-activity-label">{entry.label}</span>
                <span className="pxw-activity-meta">{entry.meta}</span>
              </div>
            ))
          ) : (
            <div className="pxw-activity-empty">Nothing has run on this project yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
