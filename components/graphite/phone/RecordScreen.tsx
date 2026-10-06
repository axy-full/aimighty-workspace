"use client";
import { useEffect, useMemo, useState } from "react";
import { useActivity } from "@/lib/control-room/use-activity";
import type { QueueItem } from "@/lib/control-room/queue";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditsText } from "@/lib/shell/price-words";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import { Price } from "../Price";
import { Eyebrow } from "./PhoneChrome";
import { budgetView, briefSpec, decisionsLine, recordRows, type Budget } from "./record-model";
import { reviewQueue, takeTitle } from "./phone-model";

/** A production's own row, as GET /api/productions carries it: its cap and what it has settled, in credits. */
type ProjectMoney = { cap: number | null; spent: number | null };

/** The project's cap and settled spend: the production row of this project (the same read the old Productions page makes). */
function useProjectMoney(scope: string, productionId: string | null): { money: ProjectMoney | null; failed: boolean } {
  const fetcher = useScopedFetch(scope);
  const [state, setState] = useState<{ id: string; money: ProjectMoney | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!productionId) return;
    let alive = true;
    void fetcher("/api/productions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("read"))))
      .then((body: { productions?: { projects?: { id: string; capCredits: number | null; spentCredits?: number }[] }[] }) => {
        if (!alive) return;
        const row = (body.productions ?? []).flatMap((p) => p.projects ?? []).find((p) => p.id === productionId);
        setState({ id: productionId, money: row ? { cap: row.capCredits ?? null, spent: typeof row.spentCredits === "number" ? row.spentCredits : null } : null, failed: false });
      })
      .catch(() => { if (alive) setState({ id: productionId, money: null, failed: true }); });
    return () => { alive = false; };
  }, [fetcher, productionId]);
  const mine = state && state.id === productionId ? state : null;
  return { money: mine?.money ?? null, failed: Boolean(mine?.failed) };
}

/**
 * The Record on the phone (frame E1): what this project has spent against its budget, its brief, what each of
 * Atomik's runs was quoted and settled at, and the decisions still open. It reads the control room's activity
 * (stream 8) and approvals queue, and the production's own cap; it changes nothing and spends nothing.
 *
 * Left out because the code has no such thing (DECISIONS 9, 13): a "held" figure, and the pause at 80% (the bar marks
 * the line and says no pause is set). Pressing Open on a plan goes to the plan screen; Review goes to the review.
 */
export function RecordScreen({ scope, project, items, queue, now, onPlan, onReview, onCut }: {
  scope: string;
  project: Project | null;
  items: readonly LibraryEntry[];
  queue: readonly QueueItem[];
  now: number;
  onPlan: (item: QueueItem) => void;
  onReview: () => void;
  /** Opens the cut: watch it and approve it (Gaps A, `screen=cut`). */
  onCut?: () => void;
}) {
  const productionId = project?.productionProjectId ?? null;
  const activity = useActivity(productionId, { enabled: Boolean(productionId) });
  const { money, failed } = useProjectMoney(scope, productionId);
  const budget: Budget | null = useMemo(() => budgetView(money?.spent, money?.cap), [money]);
  const rows = useMemo(() => recordRows(activity.reply?.runs ?? [], now), [activity.reply, now]);
  const open = useMemo(() => queue.filter((q) => q.project.draftId === project?.id), [queue, project?.id]);
  const review = useMemo(() => reviewQueue(items), [items]);
  if (!project) return <p className="ph-quiet" role="status" data-testid="phone-record-none">Pick a project on Home to see its record.</p>;
  const spec = briefSpec(project);
  const decisions = open.length + (review.length ? 1 : 0);
  return (
    <div className="ph-record" data-testid="phone-record">
      <section className="ph-section" aria-label="Spend against the budget" data-testid="phone-record-spend">
        <Eyebrow>Spend against the budget</Eyebrow>
        {budget ? (
          <>
            <div className="ph-record-spend">
              <span className="ph-record-big">{creditsText(budget.spent)}</span>
              {budget.cap ? <span className="ph-row-line ph-nowrap">of {creditsText(budget.cap)}</span> : null}
            </div>
            {budget.pct != null ? (
              <span className="ph-record-bar" role="progressbar" aria-label="Spend against the budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(budget.pct)}>
                <span className="ph-record-fill" style={{ width: `${budget.pct}%` }} />
                <span className="ph-record-line" style={{ left: `${budget.line}%` }} aria-hidden="true" />
              </span>
            ) : null}
            <p className="ph-row-line">{budget.cap ? `80% of the budget is ${creditsText(budget.at80!)}. Nothing pauses there.` : "No budget set"}</p>
          </>
        ) : <p className="ph-row-line" role="status">{failed ? "The budget could not be read. Try again later." : "Reading the budget…"}</p>}
      </section>

      <section className="ph-section" aria-label="Brief">
        <Eyebrow>Brief</Eyebrow>
        {project.brief.trim() ? <p className="ph-record-brief" data-testid="phone-record-brief">{project.brief}</p> : <p className="ph-row-line">No brief yet</p>}
        {spec ? <p className="ph-row-line" data-testid="phone-record-spec">{spec}</p> : null}
      </section>

      <section className="ph-section" aria-label="Approvals">
        <Eyebrow aside="quoted → settled">Approvals</Eyebrow>
        {activity.error && !activity.reply ? (
          <div className="ph-row ph-row--note" role="status">
            <span className="ph-row-text"><span className="ph-row-line">{activity.error}</span></span>
            <button type="button" className="ph-btn" onClick={() => void activity.refresh()}>Try again</button>
          </div>
        ) : null}
        {rows.map((row) => (
          <div key={row.id} className="ph-row ph-row--top" data-testid="phone-record-row" data-tone={row.tone}>
            <span className="ph-row-text"><span className="ph-row-title">{row.title}</span><span className="ph-row-line">{row.line}</span></span>
            <span className="ph-record-figures">
              <span className="ph-record-settled" data-tone={row.tone}>
                {row.settled ? <><Price value={row.settled} />{row.word ? ` · ${row.word}` : " settled"}</> : row.word}
              </span>
              {row.quoted ? <span className="ph-row-line ph-nowrap">quoted <Price value={row.quoted} /></span> : null}
            </span>
          </div>
        ))}
        {!rows.length && activity.status === "ready" ? <p className="ph-quiet" data-testid="phone-record-empty">Atomik has not worked on this project yet.</p> : null}
        {!rows.length && activity.status === "loading" ? <p className="ph-quiet" role="status">Reading the record…</p> : null}
      </section>

      {onCut && project.shots.length ? (
        <section className="ph-section" aria-label="The cut">
          <Eyebrow>The cut</Eyebrow>
          <div className="ph-row" data-testid="phone-record-cut"><span className="ph-row-text"><span className="ph-row-title">Watch the cut</span><span className="ph-row-line">The takes in order. Approve it from here.</span></span><button type="button" className="ph-btn" onClick={onCut} data-testid="phone-record-cut-open">Watch</button></div>
        </section>
      ) : null}

      <section className="ph-section" aria-label="Open decisions">
        <Eyebrow aside={decisions ? decisionsLine(decisions) : null}>Open decisions</Eyebrow>
        {open.map((item) => (
          <div key={item.id} className="ph-row" data-testid="phone-record-decision">
            <span className="ph-row-text">
              <span className="ph-row-title">{item.title}{item.price ? <> · <Price value={item.price} /></> : null}</span>
              <span className="ph-row-line">{item.needsAdmin && !item.canApprove ? "Needs an admin" : "Approve, change or hold"}</span>
            </span>
            {item.approve?.kind === "board-approve" ? <button type="button" className="ph-btn" onClick={() => onPlan(item)} data-testid="phone-record-open">Open</button> : null}
          </div>
        ))}
        {review.length ? (
          <div className="ph-row" data-testid="phone-record-review">
            <span className="ph-row-text"><span className="ph-row-title">{takeTitle(review[0])}</span><span className="ph-row-line">{review.length === 1 ? "A take waits for review" : `${review.length} takes wait for review`}</span></span>
            <button type="button" className="ph-btn" onClick={onReview}>Review</button>
          </div>
        ) : null}
        {!decisions ? <p className="ph-quiet" data-testid="phone-record-nodecisions">Nothing is waiting for a decision</p> : null}
      </section>
    </div>
  );
}
