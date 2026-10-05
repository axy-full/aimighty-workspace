"use client";
import { useEffect, useRef, useState } from "react";
import { usePlan } from "../board/cards/plan/use-plan";
import { usePlanRun } from "../board/cards/plan/use-run";
import { balanceLine, type PlanModel, type PlanPrimary } from "../board/cards/plan/model";
import type { BoardCtx } from "../board/cards/types";
import { Price, usePriceTitle } from "../Price";
import { creditsText } from "@/lib/shell/price-words";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { NEEDS_CONNECTION } from "./HomeScreen";

/**
 * Plan approval on the phone (design/particl-graphite/README.md § 3.6, frames B1–B3): the plan Atomik proposed,
 * step by step with each price, the admin mark, the fix allowance as information, the Total and the balance after,
 * and Approve · Change · Hold pinned under it.
 *
 * It reads the plan card's own model and actions (components/graphite/board/cards/plan, stream 4), so the board and
 * the phone show the same steps at the same prices and press the same existing, person-only route: Approve is the
 * run's own approval by the person who asked (`agent.approve`, first `agent.limit` when the limit is short), and each
 * render then asks at its own price (lead decision 27). Nothing here approves or prices anything itself.
 *
 *  - Approve waits while the balance is short, with "Short by N cr" and Top up beside it (Settings › Plan & credits).
 *  - Change hands the plan to Atomik's sheet with "Change the plan: "; it is re-priced before it can be approved.
 *  - Hold goes Home and calls nothing: the plan stays waiting in Needs you.
 *  - Offline, Approve says "Needs a connection".
 */
export const HELD_LINE = "Held · the plan is kept · nothing spent";

export function PlanScreen({ scope, project, runId, online, onHome, onTopUp, onChange }: {
  scope: string;
  project: Project | null;
  /** `run=` in the address: the run a push or a Home row opened. */
  runId: string | null;
  online: boolean;
  onHome: () => void;
  onTopUp: () => void;
  onChange: () => void;
}) {
  const { toast } = useWorkspace();
  const run = usePlanRun({ scope, productionId: project?.productionProjectId ?? null, draftId: project?.id ?? null, joined: true });
  /* Only the fields the plan's own hook reads; the phone has no board around it. */
  const ctx = { scope, project, productionId: project?.productionProjectId ?? null } as unknown as BoardCtx;
  const plan = usePlan(ctx, project ? run : null, online ? null : NEEDS_CONNECTION);
  const model = plan.model;
  const pressed = useRef(false);
  /* Approving moves the run past its proposal: say so once, and go Home where its first render waits. */
  useEffect(() => {
    if (pressed.current && model && model.phase !== "proposal") {
      pressed.current = false;
      toast(`${model.title} approved · each shot asks at its price`);
      onHome();
    }
  }, [model, toast, onHome]);

  if (!project || (!run && !model)) {
    return <PlanEmpty reading={Boolean(project) && !run} onHome={onHome} />;
  }
  if (!model) return <PlanEmpty reading onHome={onHome} />;
  const other = runId && runId !== model.runId;
  const proposal = model.phase === "proposal";
  const short = proposal && model.balance?.short != null;
  const approve = model.primary;
  return (
    <>
      <main className="ph-scroll" data-testid="mobile-scroll">
        <div className="ph-plan" data-phase={model.phase} data-testid="phone-plan">
          <div className="ph-eyebrow-row"><h2 className="ph-eyebrow" data-functional-label="">{project.name}</h2></div>
          <h2 className="ph-plan-title" data-testid="phone-plan-title">{model.title}</h2>
          {model.thinking ? <p className="ph-row-line">{model.thinking}</p> : null}
          {other ? <p className="ph-row-line" role="status">That plan is no longer waiting. This is the plan that is.</p> : null}
          <div className="ph-plan-steps">
            {model.steps.map((s) => (
              <div key={s.seq} className="ph-plan-step" data-state={s.state} data-testid="phone-plan-step">
                <span className="ph-row-text">
                  <span className="ph-row-title">{s.title}</span>
                  {s.meta ? <span className="ph-row-line">{s.meta}</span> : null}
                  {!proposal ? <span className="ph-row-line" data-tone={s.state === "failed" ? "waiting" : undefined}>{s.status}</span> : null}
                  {s.unavailable ? <span className="ph-row-line ph-row-line--warn">{s.unavailable}</span> : null}
                  {s.needsAdmin ? <span className="ph-row-line ph-row-line--warn" data-testid="phone-plan-admin">{model.adminLine}</span> : null}
                </span>
                {s.price ? <Price value={s.price} className="ph-plan-price" /> : <span className="ph-row-line">{s.unavailable ? "" : "priced when it runs"}</span>}
              </div>
            ))}
            <Allowance model={model} />
            <div className="ph-plan-total" data-testid="phone-plan-total">
              <span>Total</span>
              {model.total ? <Price value={model.total} className="ph-plan-price" /> : <span className="ph-row-line">not priced yet</span>}
            </div>
            {proposal && model.balance ? (
              <div className="ph-plan-line" data-testid="phone-plan-balance">
                <span>{model.balance.short != null ? `Balance · ${creditsText(model.balance.now)}` : `Balance after · ${creditsText(model.balance.now)} now`}</span>
                <span className="ph-plan-mono">{model.balance.short != null ? `short by ${creditsText(model.balance.short)}` : model.balance.after != null ? creditsText(model.balance.after) : ""}</span>
              </div>
            ) : null}
          </div>
          {model.modeLine ? <p className="ph-row-line ph-plan-note">{model.modeLine}</p> : null}
          {model.ruleLine ? <p className="ph-row-line ph-plan-note">{model.ruleLine}</p> : null}
          {model.note && model.primary?.kind !== "render" ? <p className="ph-row-line ph-plan-note">{model.note}</p> : null}
        </div>
      </main>
      <div className="ph-pinned" data-testid="mobile-actions">
        {short ? (
          <div className="ph-plan-short" role="status" data-testid="phone-plan-short">
            <span className="ph-plan-short-text"><strong>{balanceLine(model)}</strong> · Top up, then approve. Nothing is spent until you do.</span>
            <button type="button" className="ph-btn ph-btn--hot" onClick={onTopUp} data-testid="phone-plan-topup">Top up</button>
          </div>
        ) : null}
        {approve ? (
          <Primary primary={approve} busy={plan.busy} online={online} onPress={() => { pressed.current = approve.kind === "approve"; void plan.act(approve); }} />
        ) : null}
        {approve?.blocked && !short && approve.blocked !== NEEDS_CONNECTION ? <p className="ph-row-line ph-plan-why" role="status">{approve.blocked}</p> : null}
        {plan.problem ? <p className="ph-row-line ph-row-line--warn ph-plan-why" role="alert">{plan.problem}</p> : null}
        {proposal ? (
          <div className="ph-pair">
            <button type="button" className="ph-btn" onClick={onChange} data-testid="phone-plan-change">Change</button>
            <button type="button" className="ph-btn" onClick={() => { toast(HELD_LINE); onHome(); }} data-testid="phone-plan-hold">Hold</button>
          </div>
        ) : <button type="button" className="ph-btn" onClick={onHome} data-testid="phone-plan-done">Done</button>}
      </div>
    </>
  );
}

/** "Fixes if needed · up to 2 per shot … at most N cr": the allowance is information, never part of the Total. */
function Allowance({ model }: { model: PlanModel }) {
  if (model.fixAllowance == null) return null;
  return (
    <div className="ph-plan-line" data-testid="phone-plan-fixes">
      <span>Fixes if needed · up to 2 per shot</span>
      <span className="ph-plan-mono">at most {creditsText(model.fixAllowance)}</span>
    </div>
  );
}

function Primary({ primary, busy, online, onPress }: { primary: PlanPrimary; busy: boolean; online: boolean; onPress: () => void }) {
  const title = usePriceTitle(primary.kind === "raise" ? null : primary.price);
  const blocked = !online ? NEEDS_CONNECTION : primary.blocked;
  return (
    <button type="button" className="ph-btn ph-btn--primary" title={title ?? undefined} disabled={busy || Boolean(blocked)} onClick={onPress} data-testid="phone-plan-primary">
      {busy ? "Sending…" : !online ? NEEDS_CONNECTION : primary.label}
    </button>
  );
}

function PlanEmpty({ reading, onHome }: { reading: boolean; onHome: () => void }) {
  /* The run is read from the board; give that read a moment before saying nothing waits. */
  const [late, setLate] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLate(true), 4000); return () => clearTimeout(t); }, []);
  reading = reading && !late;
  return (
    <>
      <main className="ph-scroll" data-testid="mobile-scroll">
        <p className="ph-quiet" role="status" data-testid="phone-plan-none">{reading ? "Reading the plan…" : "Nothing is waiting for your approval in this project."}</p>
      </main>
      <div className="ph-pinned" data-testid="mobile-actions"><button type="button" className="ph-btn" onClick={onHome}>Home</button></div>
    </>
  );
}
