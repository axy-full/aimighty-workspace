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
import { planLineKey, planMoneyState } from "./money-state";
import { MoneyActions, MoneyLine, PausedBody, useMoveOffer, usePlanBudget, usePlanBudgetLine, useTopUpLabel } from "./MoneyStates";
import "./plan.css";

/**
 * The plan card (design/particl-graphite/README.md § 3.1 e; CLAUDE.md rule 14): what the plan makes and what each
 * step costs, the balance after, admin marks, and Hold · Change · the primary. Before the build the primary is
 * Build · free; at the plan gate it is the price, "Approve · 93 cr", under "Make 3 shots · 93 cr · at most 186 cr":
 * one approval by the person who asked covers the listed renders and up to two fixes per shot, within that ceiling.
 * After approval it stays while the run works, showing each step, what the plan has used, and any render that asks.
 */
export function PlanCard({ data, ctx }: CardProps<PlanData>) {
  /* The sample has no run to act on: every control is disabled with the sample's own line. */
  const readOnly = paidBlockOf(ctx) ?? data.sample?.primary?.blocked ?? null;
  const plan = usePlan(ctx, data.run, readOnly);
  const shell = useShell();
  const open = data.open;
  const model = data.sample ?? plan.model;
  const runId = data.run?.id ?? "sample";
  /* The money states (./money-state.ts): read only what the state at hand needs. The sample has none. */
  const live = Boolean(data.run) && !data.sample;
  const topUp = useTopUpLabel(ctx.scope, live && model?.phase === "proposal" && model.balance?.short != null);
  const budget = usePlanBudget(ctx.scope, ctx.productionId, live && model?.phase === "needs-you");
  const move = useMoveOffer(ctx, live ? data.run : null, live ? model : null);
  const budgetLine = usePlanBudgetLine(ctx.scope, ctx.productionId, live ? data.run?.id ?? null : null, live ? planLineKey(model?.primary, data.run?.money) : null);
  const money = live && model ? planMoneyState({ model, admin: plan.admin, shotCap: plan.rule?.rule === "cap" ? plan.rule.cap : null, budget, topUp, move }) : null;
  /* The Inspector shows the same steps from this model: the server is asked for each price once. */
  useEffect(() => { publishPlanModel(runId, model); }, [runId, model]);
  if (!model) return null;
  const proposal = model.phase === "proposal";
  const lines = [proposal ? model.totalLine : null, fixLine(model), proposal && money?.kind !== "short" ? balanceLine(model) : null].filter(Boolean).join(" · ");
  /* At the plan gate the steps are shown at once: they are what the one approval covers. */
  const gate = model.primary?.kind === "plan" && model.runId !== "sample";
  const short = model.balance?.short != null && proposal && !money;
  const paused = money?.kind === "paused" ? money : null;
  const acting = money && money.kind !== "failed" && !(proposal && plan.held);
  return (
    <article className="gx-plan" data-phase={model.phase} data-money={money?.kind} data-testid="board-plan" aria-label={paused?.title ?? model.title}>
      <div className="gx-plan-head">
        <div className="gx-plan-title">{paused?.title ?? model.title}</div>
        {paused ? <div className="gx-plan-line" data-testid="board-plan-line">{paused.sub}</div>
          : lines ? <div className="gx-plan-line" data-testid="board-plan-line">{lines}</div> : null}
        {proposal && plan.held ? <div className="gx-plan-line" role="status">On hold · nothing spent</div> : null}
      </div>
      {paused ? <PausedBody state={paused} /> : money ? <MoneyLine state={money} /> : null}
      {budgetLine ? <div className="gx-plan-state" role="note" data-testid="board-plan-budget-line"><span className="gx-plan-dot" aria-hidden="true" />{budgetLine}</div> : null}
      {money && (money.kind === "admin" || money.kind === "unavailable") && money.restLine ? <div className="gx-plan-why" data-testid="board-plan-rest">{money.restLine}</div> : null}
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
        {acting ? (
          <MoneyActions state={money!} ctx={ctx} run={data.run} primary={model.primary} busy={plan.busy} readOnly={readOnly} move={move}
            onPrimary={() => { if (model.primary) void plan.act(model.primary); }} />
        ) : model.primary && !(proposal && plan.held) ? <PrimaryButton primary={model.primary} busy={plan.busy} onPress={() => void plan.act(model.primary!)} /> : null}
      </div>
      {model.primary?.blocked && !short ? <div className="gx-plan-why" role="status">{model.primary.blocked}</div> : null}
      {plan.problem ? <div className="gx-plan-why gx-plan-problem" role="alert">{plan.problem}</div> : null}
      {model.modeLine ? <div className="gx-plan-mode">{model.modeLine}</div> : null}
      {model.note && model.primary?.kind !== "render" ? <div className="gx-plan-why">{model.note}</div> : null}
      {model.steps.length ? (
        <button type="button" className="gx-plan-toggle nodrag" aria-expanded={open || !proposal || gate} onClick={() => setPlanStepsOpen(runId, !open)} data-testid="board-plan-toggle"
          hidden={!proposal || gate}>{open ? "Hide the steps" : `Show the ${model.steps.length} ${model.steps.length === 1 ? "step" : "steps"}`}</button>
      ) : null}
      {(open || !proposal || gate) && model.steps.length ? <Steps model={model} /> : null}
    </article>
  );
}

function PrimaryButton({ primary, busy, onPress }: { primary: PlanPrimary; busy: boolean; onPress: () => void }) {
  const title = usePriceTitle(primary.kind === "raise" ? null : primary.price);
  return (
    <button type="button" className="gx-plan-primary nodrag" title={title ?? undefined} disabled={busy || Boolean(primary.blocked)} aria-busy={busy || undefined} onClick={onPress} data-testid="board-plan-primary"
      {...((primary.kind === "render" || primary.kind === "plan") && primary.price ? spendAttrsOf(primary.price) : {})}>
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
            {s.asksAlone ? <span className="gx-plan-step-flag" data-testid="board-plan-asks">{s.asksAlone}</span> : null}
            {s.needsAdmin ? <span className="gx-plan-step-flag" data-testid="board-plan-admin">{model.adminLine}</span> : null}
          </span>
          {s.state === "failed" && s.status === "Failed · nothing billed" ? <span className="gx-plan-step-later">nothing billed</span>
            : s.price ? <Price value={s.price} className="gx-plan-step-price" /> : <span className="gx-plan-step-later">{s.unavailable ? "" : "priced when it runs"}</span>}
        </div>
      ))}
      {model.ruleLine ? <div className="gx-plan-step gx-plan-step--quiet"><span>{model.ruleLine}</span></div> : null}
    </div>
  );
}
