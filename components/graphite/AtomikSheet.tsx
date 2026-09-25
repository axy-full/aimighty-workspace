"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { agentStateLabel, priceText, runButton, stepRows } from "@/lib/workspace/atomik-view";
import { pageDef, suiteOfPage } from "@/lib/workspace/pages";
import { formatCredits } from "@/lib/workspace/run-engine";
import { useWorkspace } from "@/lib/workspace/state";
import type { PageId } from "@/lib/workspace/types";
import { pageOfLegacy, suiteOfLegacy } from "@/lib/shell/ia";
import { useShell } from "@/lib/shell/state";

/**
 * The page's Atomik plan in the Suites shell: what the page head's "Run
 * stage" and the Inspector's "Approve" open (`agentOpen`). The same run
 * engine as the legacy panel and the phone sheet — its steps, its refusal,
 * and the gate, whose Approve RESUMES the run through `approve()` (never a
 * second `start()`), with the live quote on the button. Nothing animates: a
 * step moves when its backend call resolves.
 */
export function AtomikSheet() {
  const { state, dispatch } = useWorkspace();
  const shell = useShell();
  const atomik = useAtomik();
  if (!state.agentOpen) return null;
  const close = () => dispatch({ type: "patch", patch: { agentOpen: false } });

  const plan = atomik.plan(state.page);
  const run = atomik.runFor(state.page);
  const runnable = atomik.runnable(state.page);
  const button = runButton(run, runnable);
  const rows = plan ? stepRows(plan, run, atomik.ctx) : [];
  const waiting = run?.status === "waiting";
  const quote = run?.quote ?? null;
  const gatePrice = quote ? formatCredits(quote.credits, quote.unit) : null;
  /* A run held on another page stays reachable: an approval never hides. */
  const elsewhere = atomik.state.run && (!run || atomik.state.run.id !== run.id) && ["running", "waiting"].includes(atomik.state.run.status) ? atomik.state.run : null;
  const elsewherePage = elsewhere ? (elsewhere.page as PageId) : null;
  const openElsewhere = (page: PageId) => {
    const legacy = suiteOfPage(page);
    const target = pageOfLegacy(legacy, page);
    if (target) shell.goSuite(suiteOfLegacy(legacy), target.id);
  };

  return (
    <div className="gx-veil" onClick={close} data-testid="atomik-veil">
      <div className="gx-sheet gx-atomik" role="dialog" aria-modal="true" aria-label="Atomik" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }} data-testid="atomik-panel">
        <div className="gx-sheet-head">
          <span className="gx-panel-title">Atomik · {shell.page.title}</span>
          <span className="gx-pill" data-testid="atomik-state">{agentStateLabel(run)}</span>
          <span className="gx-spacer" />
          <button type="button" className="gx-hbtn" onClick={close} data-testid="atomik-close">Close</button>
        </div>
        <div className="gx-atomik-body gx-scroll">
          {elsewhere && elsewherePage ? (
            <button type="button" className="gx-hbtn gx-atomik-elsewhere" onClick={() => openElsewhere(elsewherePage)} data-testid="atomik-elsewhere">
              {pageDef(elsewherePage).title} {elsewhere.status === "waiting" ? "is waiting on your approval" : "is running"} · Open
            </button>
          ) : null}
          <div>
            <div className="gx-model-name" data-testid="atomik-plan-title">{plan?.title ?? pageDef(state.page).title}</div>
            <p className="gx-hint">{plan ? plan.line : "No plan is available for this page."}</p>
          </div>
          {plan && !runnable.ok && !run ? <p className="gx-reason" role="note" data-testid="atomik-reason">{runnable.reason}</p> : null}
          {rows.length ? (
            <ol className="gx-atomik-steps" aria-label="Steps">
              {rows.map((row, i) => (
                <li key={i} className="gx-atomik-step" data-tone={row.tone} data-testid="atomik-step">
                  <span className="gx-atomik-mark" aria-hidden="true">{row.mark}</span>
                  <span className="gx-atomik-label">{row.label}</span>
                  <span className="gx-atomik-meta">{row.meta}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {waiting ? (
            <div className="gx-atomik-gate" role="group" aria-label="Approval required" data-testid="atomik-gate">
              <div className="gx-atomik-gate-head"><span>Approval required</span><span className="gx-mono" data-testid="atomik-gate-price">{gatePrice ?? "—"}</span></div>
              {quote ? <p className="gx-hint">{quote.line}</p> : null}
              {run?.notice ? <p className="gx-hint" role="status">{run.notice}</p> : null}
              {run?.quoting ? <p className="gx-hint" role="status">Getting a fresh quote…</p> : null}
              <div className="gx-atomik-actions">
                <button type="button" className="gx-hbtn" onClick={atomik.decline} disabled={run?.approved}>Not now</button>
                {/* approve(), never start(): the run resumes from its gate. */}
                <button type="button" className="gx-primary" disabled={!quote || run?.quoting} onClick={() => void atomik.approve()} data-testid="atomik-approve">Approve {gatePrice ?? ""}</button>
              </div>
            </div>
          ) : null}
          {run?.status === "failed" && run.error ? <p className="gx-gen-error" role="alert">{run.error}</p> : null}
          {atomik.state.notice && !run ? <p className="gx-gen-error" role="alert" data-testid="atomik-notice">{atomik.state.notice}</p> : null}
        </div>
        {plan ? (
          <div className="gx-atomik-foot">
            <span className="gx-atomik-meta" data-testid="atomik-price">{priceText(plan, run)}</span>
            <span className="gx-spacer" />
            <button type="button" className="gx-primary" disabled={button.disabled} title={!runnable.ok ? runnable.reason : undefined} onClick={() => atomik.start(state.page)} data-testid="atomik-run">{button.label}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
