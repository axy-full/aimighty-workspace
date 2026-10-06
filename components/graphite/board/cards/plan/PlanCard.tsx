"use client";
import { useEffect } from "react";
import { Price, usePriceTitle } from "@/components/graphite/Price";
import { useShell } from "@/lib/shell/state";
import { spendAttrsOf } from "@/lib/spend";
import { paidBlockOf } from "../doc/DocCards";
import type { CardProps } from "../types";
import type { PlanData } from "./derive";
import { publishPlanModel, setPlanStepsOpen } from "./ui";
import { balanceLine, fixLine, type PlanModel, type PlanPrimary } from "./model";
import { usePlan } from "./use-plan";
import "./plan.css";

/**
 * The plan card (design/particl-graphite/README.md § 3.1 e; lead decision 27): what the plan makes and what each
 * step costs, the fix allowance as information, the balance after, admin marks, and Hold · Change · Approve. Approve
 * is the run's own approval by the person who asked; each render then asks at its own price, and the card says so.
 * After approval it stays while the run works, showing each step and the one tap it waits for.
 */
export function PlanCard({ data, ctx }: CardProps<PlanData>) {
  /* The sample has no run to act on: every control is disabled with the sample's own line. */
  const readOnly = paidBlockOf(ctx) ?? data.sample?.primary?.blocked ?? null;
  const plan = usePlan(ctx, data.run, readOnly);
  const shell = useShell();
  const open = data.open;
  const model = data.sample ?? plan.model;
  const runId = data.run?.id ?? "sample";
  /* The Inspector shows the same steps from this model: the server is asked for each price once. */
  useEffect(() => { publishPlanModel(runId, model); }, [runId, model]);
  if (!model) return null;
  const proposal = model.phase === "proposal";
  const lines = [proposal ? model.totalLine : null, fixLine(model), proposal ? balanceLine(model) : null].filter(Boolean).join(" · ");
  const short = model.balance?.short != null && proposal;
  return (
    <article className="gx-plan" data-phase={model.phase} data-testid="board-plan" aria-label={model.title}>
      <div className="gx-plan-head">
        <div className="gx-plan-title">{model.title}</div>
        {lines ? <div className="gx-plan-line" data-testid="board-plan-line">{lines}</div> : null}
        {proposal && plan.held ? <div className="gx-plan-line" role="status">On hold · nothing spent</div> : null}
      </div>
      {short ? (
        <div className="gx-plan-short" role="status">
          <span>{balanceLine(model)} · Top up, then approve. Nothing is spent until you do.</span>
          <button type="button" className="gx-plan-btn nodrag" onClick={() => shell.goWorkspace("credits")}>Top up</button>
        </div>
      ) : null}
      <div className="gx-plan-actions">
        {proposal ? (
          <>
            <button type="button" className="gx-plan-btn nodrag" aria-pressed={plan.held} disabled={Boolean(readOnly)}
              onClick={() => { const next = !plan.held; plan.setHeld(next); if (next) ctx.toast("On hold · nothing spent"); }} data-testid="board-plan-hold">Hold</button>
            <button type="button" className="gx-plan-btn nodrag" disabled={Boolean(readOnly)}
              onClick={() => { ctx.askAtomik("Change the plan: "); ctx.toast("Tell Atomik what to change; the plan is re-priced before approval"); }} data-testid="board-plan-change">Change</button>
          </>
        ) : null}
        {model.primary && !(proposal && plan.held) ? <PrimaryButton primary={model.primary} busy={plan.busy} onPress={() => void plan.act(model.primary!)} /> : null}
      </div>
      {model.primary?.blocked && !short ? <div className="gx-plan-why" role="status">{model.primary.blocked}</div> : null}
      {plan.problem ? <div className="gx-plan-why gx-plan-problem" role="alert">{plan.problem}</div> : null}
      {model.modeLine ? <div className="gx-plan-mode">{model.modeLine}</div> : null}
      {model.note && model.primary?.kind !== "render" ? <div className="gx-plan-why">{model.note}</div> : null}
      {model.steps.length ? (
        <button type="button" className="gx-plan-toggle nodrag" aria-expanded={open || !proposal} onClick={() => setPlanStepsOpen(runId, !open)} data-testid="board-plan-toggle"
          hidden={!proposal}>{open ? "Hide the steps" : `Show the ${model.steps.length} ${model.steps.length === 1 ? "step" : "steps"}`}</button>
      ) : null}
      {(open || !proposal) && model.steps.length ? <Steps model={model} /> : null}
    </article>
  );
}

function PrimaryButton({ primary, busy, onPress }: { primary: PlanPrimary; busy: boolean; onPress: () => void }) {
  const title = usePriceTitle(primary.kind === "raise" ? null : primary.price);
  return (
    <button type="button" className="gx-plan-primary nodrag" title={title ?? undefined} disabled={busy || Boolean(primary.blocked)} aria-busy={busy || undefined} onClick={onPress} data-testid="board-plan-primary"
      {...(primary.kind === "render" && primary.price ? spendAttrsOf(primary.price) : {})}>
      {busy ? "Sending…" : primary.label}
    </button>
  );
}

export function Steps({ model }: { model: PlanModel }) {
  return (
    <div className="gx-plan-steps" data-testid="board-plan-steps">
      {model.thinking ? <div className="gx-plan-step gx-plan-step--quiet"><span>{model.thinking}</span></div> : null}
      {model.steps.map((s) => (
        <div key={s.seq} className="gx-plan-step" data-state={s.state} data-testid="board-plan-step">
          <span className="gx-plan-step-text">
            <span>{s.title}</span>{s.meta ? <span className="gx-plan-step-meta"> · {s.meta}</span> : null}
            {model.phase !== "proposal" ? <span className="gx-plan-step-status">{s.status}</span> : null}
            {s.unavailable ? <span className="gx-plan-step-flag">{s.unavailable}</span> : null}
            {s.needsAdmin ? <span className="gx-plan-step-flag" data-testid="board-plan-admin">{model.adminLine}</span> : null}
          </span>
          {s.price ? <Price value={s.price} className="gx-plan-step-price" /> : <span className="gx-plan-step-later">{s.unavailable ? "" : "priced when it runs"}</span>}
        </div>
      ))}
      {model.ruleLine ? <div className="gx-plan-step gx-plan-step--quiet"><span>{model.ruleLine}</span></div> : null}
    </div>
  );
}
