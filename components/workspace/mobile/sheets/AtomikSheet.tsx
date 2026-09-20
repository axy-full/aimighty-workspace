"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentStateLabel, priceText, runButton, stepRows } from "@/lib/workspace/atomik-view";
import { pageDef, suiteOfPage } from "@/lib/workspace/pages";
import { formatCredits } from "@/lib/workspace/run-engine";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import type { MobileSheetBodyProps } from "./registry";

/**
 * The Atomik sheet (05-mobile "Sheets": plan, steps, gate, activity).
 *
 * Every figure and every state comes from the run engine that already serves
 * the desktop panel — lib/workspace/{plans,run-engine,use-atomik-run,activity}
 * through the one AtomikHost — so the phone and the desktop cannot disagree
 * about what is running, what it costs or what it is waiting for. Nothing here
 * animates: a step moves when its backend call resolves.
 *
 * The rule the two identically-labelled controls have to share: while a gate
 * waits, Approve calls the engine's `approve`, which re-validates the quote
 * and RESUMES the run from the gate. It never calls `start`, so a waiting run
 * is never restarted from step 0 and nothing paid is dispatched before the
 * approval. `Not now` declines through the engine.
 */
export function AtomikSheet({}: MobileSheetBodyProps) {
  const { state, go } = useWorkspace();
  const atomik = useAtomik();
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

  return (
    <div data-testid="mobile-atomik-body">
      {elsewhere && elsewherePage ? (
        <button type="button" className="pxm-elsewhere" onClick={() => go(suiteOfPage(elsewherePage), elsewherePage)}>
          <span className="pxm-dot6" style={{ background: elsewhere.status === "waiting" ? "var(--pxw-amber)" : "var(--pxw-blue)" }} aria-hidden="true" />
          <span className="pxm-grow">
            {pageDef(elsewherePage).title} {elsewhere.status === "waiting" ? "is waiting on your approval" : "is running"}
          </span>
          <span className="pxm-elsewhere-go">Open</span>
        </button>
      ) : null}

      {/* The sheet's own header already names the page, so this is the state. */}
      <div className="pxm-kicker" data-functional-label="" data-testid="mobile-atomik-state">{agentStateLabel(run)}</div>
      <div className="pxm-plan-title" data-testid="mobile-atomik-plan-title">{plan?.title ?? def.title}</div>
      <p className="pxm-plan-line">{plan ? plan.line : "No plan is available for this page."}</p>
      {plan && !runnable.ok && !run ? (
        <p className="pxm-plan-reason" role="note" data-testid="mobile-atomik-reason">{runnable.reason}</p>
      ) : null}

      {rows.length ? (
        <ol className="pxm-steps" aria-label="Steps">
          {rows.map((row, i) => (
            <li className="pxm-step" key={i} data-tone={row.tone} data-testid="mobile-atomik-step">
              <span className="pxm-step-mark" aria-hidden="true">{row.mark}</span>
              <span className="pxm-grow pxm-step-label">{row.label}</span>
              <span className="pxm-step-meta" data-gate={row.gate || undefined}>{row.meta}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {waiting ? (
        <div className="pxm-gate" role="group" aria-label="Approval required" data-testid="mobile-atomik-gate">
          <div className="pxm-gate-head">
            <span className="pxm-gate-title">Approval required</span>
            <span className="pxm-gate-price" data-testid="mobile-gate-price">{gatePrice ?? "—"}</span>
          </div>
          {quote ? <div className="pxm-gate-line">{quote.line}</div> : null}
          {run?.notice ? <div className="pxm-gate-notice" role="status">{run.notice}</div> : null}
          {run?.quoting ? <div className="pxm-gate-notice" role="status">Getting a fresh quote…</div> : null}
          <div className="pxm-gate-actions">
            <button type="button" className="pxm-gate-decline" data-testid="mobile-gate-decline" disabled={run?.approved} onClick={atomik.decline}>
              Not now
            </button>
            {/* approve(), never start(): the run resumes from its gate. */}
            <button
              type="button"
              className="pxm-gate-approve"
              data-testid="mobile-gate-approve"
              disabled={!quote || run?.quoting}
              onClick={() => void atomik.approve()}
            >
              Approve {gatePrice ?? ""}
            </button>
          </div>
        </div>
      ) : null}

      {run?.status === "failed" && run.error ? <p className="pxm-problem" role="alert">{run.error}</p> : null}
      {atomik.state.notice && !run ? <p className="pxm-problem" role="alert">{atomik.state.notice}</p> : null}

      {plan ? (
        <div className="pxm-plan-foot">
          <span className="pxm-plan-price" data-paid={plan.paid || undefined} data-testid="mobile-atomik-price">{priceText(plan, run)}</span>
          <span className="pxm-grow" />
          <button
            type="button"
            className="pxm-control pxm-plan-run"
            data-busy={button.busy || undefined}
            data-testid="mobile-atomik-run"
            disabled={button.disabled}
            title={!runnable.ok ? runnable.reason : undefined}
            onClick={() => atomik.start(state.page)}
          >
            {button.label}
          </button>
        </div>
      ) : null}

      <div className="pxm-activity" data-testid="mobile-atomik-activity">
        <div className="pxm-kicker" data-functional-label="">ACTIVITY</div>
        {atomik.activity.length ? (
          atomik.activity.map((entry) => (
            <div className="pxm-activity-row" key={entry.id}>
              <span className="pxm-grow pxm-activity-label">{entry.label}</span>
              <span className="pxm-activity-meta">{entry.meta}</span>
            </div>
          ))
        ) : (
          <div className="pxm-activity-empty">Nothing has run on this project yet.</div>
        )}
      </div>
    </div>
  );
}
