"use client";
import { useEffect, useMemo, useState } from "react";
import { usePriceTitle } from "@/components/graphite/Price";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { useShell } from "@/lib/shell/state";
import { spendAttrsOf } from "@/lib/spend";
import { draftRequest } from "@/lib/workbench/draft-request";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import { shotEngine } from "@/lib/workspace/engines";
import { rigShots } from "@/lib/workspace/shots";
import type { Topups } from "@/lib/shell/workspace-view";
import { topUpLabel, topUpPack } from "../../../settings/model";
import type { BoardCtx } from "../types";
import { stepRequest, stepShots } from "./estimates";
import type { PlanModel, PlanPrimary } from "./model";
import { movePrice, type MoneyState, type MoveOffer } from "./money-state";
import { AGENT_CHANGED } from "./use-run";

/*
 * The plan card's money states, drawn (./money-state.ts says which and with what words). Every action here is one the
 * code already has, done by a person in this browser:
 *  - Top up opens Settings › Plan & credits; the request for credits is made there by the owner or an admin.
 *  - Move Shot N: the shot's engine on the board (the Rig's patchShot, free); the plan prices it again.
 *  - Approve (the rest): the plan card's own primary, the run's approval.
 * Atomik and outside agents never reach these: the routes take a browser session only.
 */

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

/**
 * At the plan gate, before Approve: where the plan's "at most" (its server quote) would take the production against its
 * cap or budget, in the server's one line (GET /api/workbench/budget with the run; lib/budgetPause.ts planBudgetLine).
 * An approved plan runs to the cap without asking; this is said before the person approves it. Null when nothing to say.
 * `gate` is ./money-state.ts planLineKey (null off the gate): a re-priced plan or spend that moved reads the line again.
 */
export function usePlanBudgetLine(scope: string, productionId: string | null, runId: string | null, gate: string | null): string | null {
  const [line, setLine] = useState<{ key: string; text: string | null } | null>(null);
  const key = `${productionId}|${runId}|${gate}`;
  useEffect(() => {
    if (!gate || !productionId || !runId) return;
    let alive = true;
    void draftRequest<{ plan?: { line: string | null } | null }>(`/api/workbench/budget?productionId=${encodeURIComponent(productionId)}&runId=${encodeURIComponent(runId)}`, scope)
      .then((r) => { if (alive) setLine({ key, text: r?.plan?.line ?? null }); })
      .catch(() => { /* no line: Approve keeps its price, and the gate holds at the cap */ });
    return () => { alive = false; };
  }, [scope, productionId, runId, gate, key]);
  return gate && line?.key === key ? line.text : null;
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
  return { seq: target.seq, engine: plan.engine, engineLabel: plan.label, price: quote && quote.credits != null && !quote.approximate ? movePrice(quote.credits, quote.usd) : null, nodeId: plan.nodeId };
}

type Props = {
  state: MoneyState;
  ctx: BoardCtx;
  primary: PlanPrimary | null;
  busy: boolean;
  readOnly: string | null;
  onPrimary: () => void;
  move: MoveOffer | null;
};

/** The state's line: an amber dot and the words ("Short by 53 cr"). */
export function MoneyLine({ state }: { state: MoneyState }) {
  return <div className="gx-plan-state" role="status" data-testid="board-plan-money" data-state={state.kind}><span className="gx-plan-dot" aria-hidden="true" />{state.line}</div>;
}

/** The state's buttons. Exactly one is filled: the next step. */
export function MoneyActions({ state, ctx, primary, busy, readOnly, onPrimary, move }: Props) {
  const shell = useShell();
  const blocked = Boolean(readOnly);
  const moveTitle = usePriceTitle(state.kind === "unavailable" ? state.move?.price ?? null : null);

  const approveBlocked = busy || blocked || Boolean(primary?.blocked);
  /* The plan's own button (lib/workbench/plan-approval.ts through the plan model): Build · free before the build, and at the
     plan gate the server's total, "Approve · 93 cr". The money
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
  return null;
}
