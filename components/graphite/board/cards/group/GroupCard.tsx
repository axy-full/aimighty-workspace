"use client";
import { useState } from "react";
import { GROUP_GAP, GROUP_PAD } from "@/lib/board/layout";
import type { GroupData } from "@/lib/board/types";
import { draftRequest, DraftRequestError } from "@/lib/workbench/draft-request";
import { creditsText, exact } from "@/lib/shell/price-words";
import { useProjectBudget } from "@/components/workspace/spec/use-spec-data";
import { usePriceTitle } from "@/components/graphite/Price";
import { defineCard, type CardProps } from "../types";
import type { ShotsGroupData } from "../take/shots-derive";
import "./group.css";

/*
 * The group frame every board region draws its cards in (README § 2: groups 14 radius, a hairline; the label on
 * the top border, title 15/600 and meta 14 at 60 %). Stream 5 owns the kind; stream 4's Looks and Storyboard
 * groups use it too. The canvas lays the children out inside it (`container`); the frame never positions them.
 *
 * The Shots group adds two things from today's backend:
 * - its cost line, "N of B cr so far": the production's settled credits against its cap (GET /api/projects);
 * - Stop, only while a Board run is working on the shots: the run's own stop (POST /api/workbench/team-canvas
 *   `agent.stop`), which skips every render not yet sent; what is already rendering finishes and is charged.
 *   There is no Stop for a take on its own: an engine cannot be stopped mid-render (DECISIONS 13).
 */

const API = "/api/workbench/team-canvas";

function CostLine({ productionId, scope, live, spent }: { productionId: string | null; scope: string; live: boolean; spent: number | null }) {
  const budget = useProjectBudget(spent == null ? productionId : null, scope);
  const credits = spent ?? budget?.credits ?? null;
  const title = usePriceTitle(exact(credits)) ?? undefined;
  if (credits == null) return null;
  const count = credits.toLocaleString("en-US", { maximumFractionDigits: 1 });
  const text = spent != null ? `${creditsText(spent)} spent`
    : budget?.capCredits != null ? `${count} of ${creditsText(budget.capCredits)}${live ? " so far" : ""}`
    : `${creditsText(credits)}${live ? " so far" : ""}`;
  return <span className="gx-group-meta gx-group-cost" title={title} data-testid="shots-cost">{text}</span>;
}

function StopRun({ runId, productionId, scope, toast }: { runId: string; productionId: string | null; scope: string; toast: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!productionId) return null;
  const stop = async () => {
    setBusy(true);
    try {
      await draftRequest<unknown>(API, scope, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productionId, action: "agent.stop", runId }) });
      toast("Stopped · what finished is billed; nothing more");
    } catch (error) {
      toast(error instanceof DraftRequestError && error.status && error.status < 500 ? error.message : "The run could not be stopped just now. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="gx-group-btn nodrag nopan" disabled={busy} aria-busy={busy} onClick={(e) => { e.stopPropagation(); void stop(); }} data-testid="shots-stop">
      {busy ? "Stopping…" : "Stop"}
    </button>
  );
}

export function GroupCard({ data, ctx }: CardProps<GroupData>) {
  const shots = data as ShotsGroupData;
  /* On the new interface's stage grid (components/v12/board/stage-grid.ts) the group has no frame and no title (the stage header says them);
     what its label carried that nothing else shows, a run's Stop and its cost, stays as a strip. */
  const grid = data.grid === true;
  const strip = !grid || Boolean(shots.stop);
  return (
    <section className="gx-group" data-tone={data.tone} aria-label={data.title} data-testid="board-group" data-grid={grid || undefined}>
      {strip ? <div className="gx-group-label">
        {grid ? null : <span className="gx-group-title">{data.title}</span>}
        {data.meta && !grid ? <span className="gx-group-meta">{data.meta}</span> : null}
        {shots.cost ? <CostLine productionId={ctx.productionId} scope={ctx.scope} live={shots.cost.live} spent={shots.cost.spent} /> : null}
        {shots.stop && !ctx.offline ? <StopRun runId={shots.stop.runId} productionId={ctx.productionId} scope={ctx.scope} toast={(t) => ctx.toast(t)} /> : null}
      </div> : null}
    </section>
  );
}

/** Groups take their size from their children: the group's own columns and gap (the master's 14 between cards, 24 around). */
export const groupDef = defineCard<GroupData>({
  kind: "group",
  size: () => ({ w: 240, h: 120 }),
  container: (data) => ({ columns: Number(data.columns) || 2, gap: Number(data.gap) || GROUP_GAP, pad: GROUP_PAD, fill: true }),
  Card: GroupCard,
});
