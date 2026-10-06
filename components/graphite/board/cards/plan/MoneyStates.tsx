"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePriceTitle } from "@/components/graphite/Price";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { useShell } from "@/lib/shell/state";
import { spendAttrsOf } from "@/lib/spend";
import { DraftRequestError, draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import { shotEngine } from "@/lib/workspace/engines";
import { rigShots } from "@/lib/workspace/shots";
import type { Topups } from "@/lib/shell/workspace-view";
import { topUpLabel, topUpPack } from "../../../settings/model";
import type { BoardCtx } from "../types";
import { stepRequest, stepShots } from "./estimates";
import type { PlanModel, PlanPrimary } from "./model";
import { movePrice, type BudgetRead, type MoneyState, type MoveOffer } from "./money-state";
import { AGENT_CHANGED } from "./use-run";

/*
 * The plan card's money states, drawn (./money-state.ts says which and with what words). Every action here is one the
 * code already has, done by a person in this browser:
 *  - Top up opens Settings › Plan & credits; the request for credits is made there by the owner or an admin.
 *  - Ask an admin: POST /api/workbench/ask-admin (a signed-in person only; it tells, and spends nothing).
 *  - Move Shot N: the shot's engine on the board (the Rig's patchShot, free); the plan prices it again.
 *  - Approve (the rest), Continue · N cr: the plan card's own primary, the run's approval and the render's tap.
 *  - Stop: the run's own stop (POST /api/workbench/team-canvas agent.stop): what is made stays.
 * Atomik and outside agents never reach these: the routes take a browser session only.
 */

const TEAM = "/api/workbench/team-canvas";

/** The smallest pack's "Top up · 500 cr · $50", from the platform's pack list; plain "Top up" until it is read. */
export function useTopUpLabel(scope: string, wanted: boolean): string {
  const [label, setLabel] = useState("Top up");
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void draftRequest<Topups>("/api/workspaces/topups", scope)
      .then((t) => { const pack = t?.applies ? topUpPack(t.packs ?? []) : null; if (alive && pack) setLabel(topUpLabel(pack)); })
      .catch(() => { /* the plain word: Settings shows the packs */ });
    return () => { alive = false; };
  }, [scope, wanted]);
  return label;
}

/** The production's budget as the gate reckons it (GET /api/workbench/budget), read again when the run moves. */
export function usePlanBudget(scope: string, productionId: string | null, wanted: boolean): BudgetRead | null {
  const [budget, setBudget] = useState<{ id: string; value: BudgetRead | null } | null>(null);
  const read = useCallback(() => {
    if (!productionId || !wanted) return;
    void draftRequest<{ budget: BudgetRead | null }>(`/api/workbench/budget?productionId=${encodeURIComponent(productionId)}`, scope)
      .then((r) => setBudget({ id: productionId, value: r?.budget ?? null }))
      .catch(() => { /* no figure, no paused state: the gate still asks on its own */ });
  }, [scope, productionId, wanted]);
  useEffect(() => {
    read();
    window.addEventListener(AGENT_CHANGED, read);
    return () => window.removeEventListener(AGENT_CHANGED, read);
  }, [read]);
  return budget && budget.id === productionId ? budget.value : null;
}

/**
 * At the plan gate, before Approve: where the plan's "at most" (its server quote) would take the production against its
 * cap or budget, in the server's one line (GET /api/workbench/budget with the run; lib/budgetPause.ts planBudgetLine).
 * An approved plan runs to the cap without asking; this is said before the person approves it. Null when nothing to say.
 */
export function usePlanBudgetLine(scope: string, productionId: string | null, runId: string | null, atGate: boolean): string | null {
  const [line, setLine] = useState<{ key: string; text: string | null } | null>(null);
  const key = `${productionId}|${runId}`;
  useEffect(() => {
    if (!atGate || !productionId || !runId) return;
    let alive = true;
    void draftRequest<{ plan?: { line: string | null } | null }>(`/api/workbench/budget?productionId=${encodeURIComponent(productionId)}&runId=${encodeURIComponent(runId)}`, scope)
      .then((r) => { if (alive) setLine({ key, text: r?.plan?.line ?? null }); })
      .catch(() => { /* no line: Approve keeps its price, and the gate holds at the cap */ });
    return () => { alive = false; };
  }, [scope, productionId, runId, atGate, key]);
  return atGate && line?.key === key ? line.text : null;
}

/**
 * Another engine for a step whose engine can't render: the engine another shot of the plan renders on, and the
 * server's quote for this step on it (the same free quote the plan's other prices come from). Null when there is none.
 */
export function useMoveOffer(ctx: BoardCtx, run: RigAgentRunView | null, model: PlanModel | null): MoveOffer | null {
  const target = model?.phase === "proposal" ? model.steps.find((s) => s.unavailable && s.state !== "skipped") ?? null : null;
  const plan = useMemo(() => {
    if (!run || !target) return null;
    const shots = stepShots(run, ctx.project);
    const nodeId = shots.get(target.seq);
    if (!nodeId) return null;
    const engines = rigShots(ctx.project);
    const own = engines.find((s) => s.id === nodeId)?.engine;
    const other = model!.steps.filter((s) => s.seq !== target.seq && s.price && !s.unavailable)
      .map((s) => engines.find((e) => e.id === shots.get(s.seq))?.engine).find((e) => e && e !== own && shotEngine(e));
    if (!other) return null;
    const moved = { ...ctx.project, nodes: ctx.project.nodes.map((n) => (n.id === nodeId ? { ...n, engine: other } : n)) };
    const request = stepRequest(moved, nodeId);
    return request ? { nodeId, engine: other, label: shotEngine(other)!.label, body: request.body } : null;
  }, [run, target, ctx.project, model]);
  const quotes = useStageQuotes(ctx.scope, plan ? { move: { body: plan.body } } : {});
  const quote = quotes.quotes.move;
  if (!plan || !target) return null;
  return { seq: target.seq, engine: plan.engine, engineLabel: plan.label, price: quote && quote.credits != null && !quote.approximate ? movePrice(quote.credits) : null, nodeId: plan.nodeId };
}

type Props = {
  state: MoneyState;
  ctx: BoardCtx;
  run: RigAgentRunView | null;
  primary: PlanPrimary | null;
  busy: boolean;
  readOnly: string | null;
  onPrimary: () => void;
  move: MoveOffer | null;
};

/** The state's line: an amber dot and the words ("Short by 53 cr"). */
export function MoneyLine({ state }: { state: MoneyState }) {
  if (state.kind === "paused") return null;
  return <div className="gx-plan-state" role="status" data-testid="board-plan-money" data-state={state.kind}><span className="gx-plan-dot" aria-hidden="true" />{state.line}</div>;
}

/** The paused state's body: what is used of the budget, the bar, the next render and where the budget is set. */
export function PausedBody({ state }: { state: Extract<MoneyState, { kind: "paused" }> }) {
  return (
    <>
      <div className="gx-plan-state" role="status" data-testid="board-plan-money" data-state="paused"><span className="gx-plan-dot" aria-hidden="true" />{state.line}</div>
      <div className="gx-plan-bar" role="progressbar" aria-label={state.sub} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.fraction * 100)}>
        <span style={{ width: `${state.fraction * 100}%` }} />
      </div>
      <div className="gx-plan-steps">
        {state.rows.map((r) => (
          <div key={r.name} className="gx-plan-step gx-plan-step--quiet" data-testid="board-plan-budget-row">
            <span>{r.name}</span><span className="gx-plan-step-value">{r.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** The state's buttons. Exactly one is filled: the next step. */
export function MoneyActions({ state, ctx, run, primary, busy, readOnly, onPrimary, move }: Props) {
  const shell = useShell();
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const blocked = Boolean(readOnly);
  const continueTitle = usePriceTitle(state.kind === "paused" ? state.price : null);
  const moveTitle = usePriceTitle(state.kind === "unavailable" ? state.move?.price ?? null : null);

  const ask = async (seq: number) => {
    if (asking || !run || !ctx.productionId) return;
    setAsking(true);
    try {
      const r = await draftRequest<{ line: string }>("/api/workbench/ask-admin", ctx.scope, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ about: "step", productionId: ctx.productionId, runId: run.id, seq }),
      });
      ctx.toast(r.line);
    } catch (error) {
      ctx.toast(error instanceof DraftRequestError && error.status && error.status < 500 ? error.message : "The ask did not go. Try again.");
    } finally { setAsking(false); }
  };
  const stop = async () => {
    if (stopping || !run || !ctx.productionId) return;
    setStopping(true);
    try {
      await draftRequest(TEAM, ctx.scope, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId: ctx.productionId, action: "agent.stop", runId: run.id }) });
      ctx.toast("Stopped. What is made stays; nothing more is spent.");
    } catch {
      ctx.toast("The stop did not go. Try again.");
    } finally { setStopping(false); window.dispatchEvent(new Event(AGENT_CHANGED)); }
  };
  const approveBlocked = busy || blocked || Boolean(primary?.blocked);
  /* The plan's own button (lib/workbench/plan-approval.ts through the plan model): Build · free before the build, and at the
     plan gate the server's total, "Approve · 93 cr" or "Approve the rest · 50 cr" with an admin's step left out. The money
     states never word it themselves once the model has; they only place it. */
  const plan = primary && (primary.kind === "approve" || primary.kind === "plan") ? primary : null;
  const planAttrs = plan?.kind === "plan" ? spendAttrsOf(plan.price) : {};
  const planTitle = usePriceTitle(plan?.kind === "plan" ? plan.price : null);

  if (state.kind === "short") {
    return (
      <>
        <button type="button" className="gx-plan-primary nodrag" onClick={() => shell.goWorkspace("credits")} data-testid="board-plan-topup">{state.topUp}</button>
        {primary ? <button type="button" className="gx-plan-btn nodrag" disabled aria-disabled="true" title={primary.blocked ?? undefined} data-testid="board-plan-primary" {...planAttrs}>{primary.label}</button> : null}
      </>
    );
  }
  if (state.kind === "admin") {
    return (
      <>
        <button type="button" className="gx-plan-primary nodrag" disabled={asking || blocked} aria-busy={asking || undefined} onClick={() => void ask(state.seqs[0])} data-testid="board-plan-ask-admin">{asking ? "Asking…" : "Ask an admin"}</button>
        {plan ? <button type="button" className="gx-plan-btn nodrag" title={planTitle ?? undefined} disabled={approveBlocked} onClick={onPrimary} data-testid="board-plan-primary" {...planAttrs}>{busy ? "Sending…" : plan.label}</button> : null}
      </>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <>
        {plan ? <button type="button" className="gx-plan-primary nodrag" title={planTitle ?? undefined} disabled={approveBlocked} onClick={onPrimary} data-testid="board-plan-primary" {...planAttrs}>{busy ? "Sending…" : plan.label}</button> : null}
        {state.move && move?.nodeId ? (
          <button type="button" className="gx-plan-btn nodrag" title={moveTitle ?? undefined} disabled={blocked}
            onClick={() => { const nodeId = move.nodeId!; const said = ctx.rig.patchShot(nodeId, { engine: state.move!.engine }); ctx.toast(said ?? `${state.move!.label.replace(/^Move /, "Moved ").replace(/ · .*$/, "")}. The plan is priced again.`); window.dispatchEvent(new Event(AGENT_CHANGED)); }}
            data-testid="board-plan-move">{state.move.label}</button>
        ) : null}
      </>
    );
  }
  if (state.kind === "paused") {
    return (
      <>
        <button type="button" className="gx-plan-primary nodrag" title={continueTitle ?? undefined} disabled={approveBlocked} onClick={onPrimary} data-testid="board-plan-primary"
          {...spendAttrsOf(state.price)}>{busy ? "Sending…" : state.continueLabel}</button>
        <button type="button" className="gx-plan-btn nodrag" disabled={stopping || blocked} onClick={() => void stop()} data-testid="board-plan-stop">{stopping ? "Stopping…" : "Stop · keep what’s made"}</button>
      </>
    );
  }
  return null;
}
