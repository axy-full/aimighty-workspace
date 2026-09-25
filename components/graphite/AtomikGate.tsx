"use client";
import { useState } from "react";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { formatCredits } from "@/lib/workspace/run-engine";

/**
 * The Suites shell's Atomik gate: one row under the stage strip, on every
 * page, whenever the one run the engine holds needs a word from you. A priced
 * run waits here with Approve (the exact quote) and Not now; a plan that
 * cannot run says why; a run that failed says what failed. The legacy shells
 * have AtomikPanel and the phone sheet for this; the Suites shell had nothing,
 * so '+ Run stage' stopped at a price nobody could see or approve.
 */
export function AtomikGate() {
  const atomik = useAtomik();
  const run = atomik.state.run;
  const notice = atomik.state.notice;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const title = run ? atomik.plan(run.page)?.title ?? "Atomik" : "Atomik";

  if (run?.status === "waiting") {
    const price = run.quote ? formatCredits(run.quote.credits, run.quote.unit) : null;
    return (
      <div className="gx-gate" role="group" aria-label="Approval required" data-testid="suites-atomik-gate">
        <div className="gx-gate-text">
          <span className="gx-gate-title">{title} · approval required</span>
          {run.quote ? <span className="gx-gate-line">{run.quote.line}</span> : null}
          {run.notice ? <span className="gx-gate-line" role="status">{run.notice}</span> : null}
          {run.quoting ? <span className="gx-gate-line" role="status">Getting a fresh quote…</span> : null}
        </div>
        <button type="button" className="gx-hbtn" disabled={run.approved} onClick={atomik.decline} data-testid="suites-gate-decline">Not now</button>
        {/* approve(), never start(): the run resumes from its gate at exactly this price. */}
        <button type="button" className="gx-primary" disabled={!run.quote || run.quoting} onClick={() => void atomik.approve()} data-testid="suites-gate-approve">
          {price ? `Approve ${price}` : "Approve"}
        </button>
      </div>
    );
  }
  if (run?.status === "failed" && run.error && dismissed !== run.id) {
    return (
      <div className="gx-gate" role="alert" data-testid="suites-atomik-failed">
        <div className="gx-gate-text"><span className="gx-gate-title">{title} stopped</span><span className="gx-gate-line">{run.error}</span></div>
        <button type="button" className="gx-hbtn" onClick={() => setDismissed(run.id)}>Dismiss</button>
      </div>
    );
  }
  if (notice) {
    return (
      <div className="gx-gate" role="alert" data-testid="suites-atomik-notice">
        <div className="gx-gate-text"><span className="gx-gate-line">{notice}</span></div>
        <button type="button" className="gx-hbtn" onClick={atomik.dismissNotice}>Dismiss</button>
      </div>
    );
  }
  return null;
}
