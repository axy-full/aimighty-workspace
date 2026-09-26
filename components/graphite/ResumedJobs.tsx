"use client";
import { useEffect, useState } from "react";
import { isOpen, resumeLine, resumePhase, type ResumeJob } from "@/lib/higgsfield-consumer/resume";

/**
 * Connected-account jobs picked back up after the page was left: one line per
 * job, the state in a few words, how long it has been going while it is still
 * followed, and what a person can do about a problem. Shared by Business and
 * Viral; Gen shows the same facts as cards in its Results grid.
 */
export type ResumedRow = ResumeJob & { id: string; name: string; createdAt: number; problem?: string | null; following: boolean };

/** The time, re-read every `ms` (0 = still); ages on the rows move without a re-fetch. */
export function useClock(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms <= 0) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0), timer = setInterval(tick, ms);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [ms]);
  return now;
}

/** An open job nobody is asking after any more can be dismissed; so can a settled one. */
export const dismissable = (row: { status: string; following: boolean }) => !(row.following && isOpen(row.status));

export function ResumedJobRows({ rows, label, onDismiss, onOpen, testId }: {
  rows: ResumedRow[];
  /** What the list is, for a screen reader. */
  label: string;
  /** Hides the row for this viewer; nothing is deleted. */
  onDismiss?: (id: string) => void;
  /** Where a finished job's result is (Takes). */
  onOpen?: () => void;
  testId: string;
}) {
  const now = useClock(rows.some((row) => row.following) ? 30_000 : 0);
  if (!rows.length) return null;
  return (
    <ul className="gx-resumed" aria-label={label} data-testid={testId}>
      {rows.map((row) => {
        const phase = resumePhase(row, row.following);
        const open = row.status === "completed" && onOpen;
        const dismiss = dismissable(row) && onDismiss;
        return (
          <li className="vr-job gx-resumed-row" key={row.id} data-status={row.status} data-tone={phase.tone} data-following={row.following} data-testid={`${testId}-row`}>
            <span className="gx-resumed-dot" aria-hidden="true" />
            <span className="vr-job-name" title={row.name}>{row.name}</span>
            <span className="gx-resumed-state">{resumeLine(row, now, row.following)}</span>
            {row.problem ? <p className="gx-resumed-problem" role="status">{row.problem}</p> : null}
            {open || dismiss ? (
              <span className="gx-resumed-actions">
                {open ? <button type="button" className="gx-hbtn gx-resumed-x gx-resumed-open" onClick={onOpen}>Open Takes</button> : null}
                {dismiss ? <button type="button" className="gx-hbtn gx-resumed-x" onClick={() => onDismiss(row.id)} aria-label={`Dismiss ${row.name}`}>Dismiss</button> : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
