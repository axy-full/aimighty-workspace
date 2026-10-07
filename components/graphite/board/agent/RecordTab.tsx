"use client";
import { useMemo } from "react";
import { useShell } from "@/lib/shell/state";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { useActivity } from "@/lib/control-room/use-activity";
import { recordApprovals, recordBrief, recordBudget, recordDecisions } from "@/lib/shell/project-record";
import { runningTime, sheetLength } from "../cards/doc/model";
import type { BoardCtx } from "../cards/types";
import { Price } from "../../Price";
import { useBudget } from "./use-budget";

/*
 * The Project record, the docked panel's second tab (design/particl-graphite/README.md § 3.1 n): the brief, what was
 * approved and what it settled at, what still waits for a person, and spend against the budget. Everything is read
 * from what exists today (the draft, the activity read, the approvals queue, the production's cap); nothing here
 * approves or spends. Prices are never cut short; a title may be.
 */
const time = (at: number | null) => (at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

export function RecordTab({ ctx, onAtomik }: { ctx: BoardCtx; onAtomik: () => void }) {
  const shell = useShell();
  const production = ctx.productionId;
  const activity = useActivity(production);
  const approvals = useApprovals();
  const { budget, error: budgetError } = useBudget(production);
  const brief = useMemo(() => {
    const length = sheetLength(ctx.project.production?.beats);
    return recordBrief({ brief: ctx.project.brief, direction: ctx.project.direction, aspect: ctx.project.aspect, fps: ctx.project.fps, length: length != null ? runningTime(length) : null });
  }, [ctx.project]);
  const rows = useMemo(() => recordApprovals(activity.reply?.runs ?? []), [activity.reply]);
  const decisions = useMemo(() => recordDecisions(approvals.items, production), [approvals.items, production]);
  const shown = budget ?? recordBudget({ inCredits: false, cap: null, spent: null });

  return (
    <div className="ag-body ag-record" data-testid="board-record">
      <section className="ag-sec" aria-label="Brief">
        <span className="ag-eyebrow ag-eyebrow-quiet">Brief</span>
        {brief.brief ? <p className="ag-rec-brief" data-testid="record-brief">{brief.brief}</p> : <p className="ag-sub">No brief yet.</p>}
        {brief.look ? <p className="ag-sub">{brief.look}</p> : null}
        {brief.footer ? <p className="ag-sub ag-mono">{brief.footer}</p> : null}
      </section>

      <section className="ag-sec" aria-label="Approvals">
        <span className="ag-eyebrow ag-eyebrow-quiet ag-eyebrow-row"><span>Approvals</span><span>Priced → settled</span></span>
        {activity.status === "loading" ? <p className="ag-sub" role="status">Reading what was approved…</p> : null}
        {activity.status === "error" ? <p className="ag-sub" role="alert">{activity.error} <button type="button" className="ag-link" onClick={() => void activity.refresh()}>Try again</button></p> : null}
        {activity.status === "ready" && !rows.length ? <p className="ag-sub" data-testid="record-none">Nothing approved yet. Each approval lands here at its price, then at what it settled at.</p> : null}
        <ul className="ag-recs" data-testid="record-approvals">
          {rows.map((row) => (
            <li key={row.id} className="ag-rec" data-testid="record-approval">
              <span className="ag-rec-main">
                <span className="ag-rec-title">{row.title}</span>
                <span className="ag-sub">{row.auto ? "spent without asking" : row.by ? `approved by ${row.by}` : "approved"}{row.at ? ` · ${time(row.at)}` : ""}</span>
              </span>
              <span className="ag-rec-price ag-mono" data-testid="record-price">
                {row.priced ? <Price value={row.priced} /> : null}
                {row.priced && row.settled.kind !== "none" ? <span aria-hidden="true"> → </span> : null}
                {row.settled.kind === "price" ? <Price value={row.settled.price} /> : row.settled.kind === "settling" ? <span>settling</span> : row.settled.kind === "nothing" ? <span>Nothing billed</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="ag-sec" aria-label="Open decisions">
        <span className="ag-eyebrow ag-eyebrow-quiet">Open decisions</span>
        {!decisions.length ? <p className="ag-sub" data-testid="record-no-decisions">Nothing waits for you on this project.</p> : null}
        {decisions.map((d) => (
          <div key={d.id} className="ag-dec" data-testid="record-decision">
            <span className="ag-rec-title">{d.title}</span>
            <button type="button" className="ag-link" onClick={() => (d.where === "board" ? onAtomik() : shell.goControlRoom("approvals"))}>Open</button>
          </div>
        ))}
      </section>

      <section className="ag-sec" aria-label="Spend against the budget">
        <span className="ag-eyebrow ag-eyebrow-quiet ag-eyebrow-row"><span>Spend against the budget</span>{shown.kind === "capped" ? <span className="ag-mono" data-testid="record-budget-line">{shown.line}</span> : null}</span>
        {shown.kind === "capped" ? (
          <div className="ag-bar" role="progressbar" aria-valuemin={0} aria-valuemax={shown.cap} aria-valuenow={Math.min(shown.spent, shown.cap)} aria-label="Spend against the budget" data-over={shown.over ? "" : undefined}>
            <span style={{ width: `${Math.round(shown.fraction * 100)}%` }} />
          </div>
        ) : shown.kind === "none" ? <p className="ag-sub" data-testid="record-budget-line">{shown.line}</p>
          : <p className="ag-sub" data-testid="record-budget-line">{budgetError ? "The budget could not be read." : budget ? "Spend isn’t shown in credits for this workspace." : "Reading the budget…"}</p>}
      </section>
    </div>
  );
}
