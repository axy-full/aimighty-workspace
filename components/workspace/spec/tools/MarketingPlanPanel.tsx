"use client";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { runChip } from "@/lib/workspace/atomik-view";
import { Button, Kicker } from "../../ui";

/**
 * The Marketing section's agent panel in the workspace: the page's own Atomik
 * plan, run on the shell's host.
 *
 * /workbench fills this slot with its Studio agent panels, which need Studio's
 * Atomik internals (runGenie, applyPlan, its job feeds and its context and
 * activity tabs). The workspace's equivalent is the plan itself, so this shows
 * the plan, its live price and one button that starts it on the same engine,
 * gate and panel every other workspace surface uses. There is no second copy
 * of the quote or the approval here — the engine owns both.
 */
export function MarketingPlanPanel() {
  const atomik = useAtomik();
  const plan = atomik.plan("marketing");
  if (!plan) return null;
  const run = atomik.runFor("marketing");
  const runnable = atomik.runnable("marketing");
  const chip = runChip(run);
  /* Pausing, and opening a waiting gate, stay possible whatever the page holds now. */
  const disabled = !runnable.ok && chip.tone === "idle";
  const reason = runnable.ok ? null : runnable.reason;
  return (
    <section className="pxw-mkt-plan" aria-label="Atomik plan" data-testid="marketing-plan-panel">
      <Kicker>Atomik plan</Kicker>
      <div className="pxw-mkt-plan-title">{plan.title}</div>
      <p className="pxw-mkt-plan-line">{plan.line}</p>
      <div className="pxw-mkt-plan-price">{run?.quote ? chip.label.replace(/^Approve /, "") : plan.priceLabel}</div>
      <Button
        variant={chip.tone === "waiting" ? "amber" : "primary"}
        className="pxw-mkt-plan-run"
        disabled={disabled}
        aria-describedby={reason && disabled ? "pxw-marketing-plan-reason" : undefined}
        onClick={() => atomik.start("marketing")}
      >
        <span>{chip.label}</span>
      </Button>
      {reason && disabled ? (
        <p className="pxw-mkt-plan-reason" id="pxw-marketing-plan-reason" data-testid="marketing-plan-reason">{reason}</p>
      ) : null}
      {run?.error ? <p className="pxw-mkt-plan-error" role="alert">{run.error}</p> : null}
    </section>
  );
}
