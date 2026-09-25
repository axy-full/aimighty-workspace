"use client";
import { useEffect, useState } from "react";
import { isResumable, resumeAge, resumePhase } from "@/lib/higgsfield-consumer/resume";

/**
 * Connected-account jobs picked back up after the page was left: one line per
 * job, the state in one word, how long it has been going, and what a person
 * can do about a problem. Shared by Business and Viral; Gen shows the same
 * facts as cards in its Results grid.
 */
export type ResumedRow = { id: string; name: string; status: string; createdAt: number; problem?: string | null };

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

/** "Rendering · 12 min", "Confirming · 2 h", "Complete", "Failed · not billed". */
export function resumeLine(status: string, createdAt: number, now: number) {
  const phase = resumePhase(status);
  return isResumable(status) ? `${phase.label} · ${resumeAge(createdAt, now)}` : phase.label;
}

export function ResumedJobRows({ rows, label, onDismiss, onOpen, testId }: {
  rows: ResumedRow[];
  /** What the list is, for a screen reader. */
  label: string;
  onDismiss?: (id: string) => void;
  /** Where a finished job's result is (Takes). */
  onOpen?: () => void;
  testId: string;
}) {
  const now = useClock(rows.length ? 30_000 : 0);
  if (!rows.length) return null;
  return (
    <ul className="gx-resumed" aria-label={label} data-testid={testId}>
      {rows.map((row) => {
        const phase = resumePhase(row.status);
        const open = row.status === "completed" && onOpen;
        const dismiss = (row.status === "completed" || row.status === "failed") && onDismiss;
        return (
          <li className="vr-job gx-resumed-row" key={row.id} data-status={row.status} data-tone={phase.tone} data-testid={`${testId}-row`}>
            <span className="gx-resumed-dot" aria-hidden="true" />
            <span className="vr-job-name" title={row.name}>{row.name}</span>
            <span className="gx-resumed-state" title={row.status === "uncertain" ? "The account has not confirmed it yet. It is never sent twice." : undefined}>{resumeLine(row.status, row.createdAt, now)}</span>
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
