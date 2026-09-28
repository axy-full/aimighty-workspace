"use client";
import type { ReactNode } from "react";

/**
 * One Generate's takes 2–4, drawn as ONE strip (lib/variations.ts): a head that
 * says what the batch is — "take 1–4", its prompt, what it cost — and the
 * takes side by side, each labelled "take N" by its own number. Gen's Results
 * (a batch rendering now, and the ones in the library) and Studio › Takes draw
 * it; each passes its own take cards as children.
 */
export function TakeStrip({ label, name, meta, state, batchId, testId, plain = false, foot, children }: {
  /** "take 1–4". */
  label: string;
  /** The prompt, shortened. */
  name: string;
  /** What it is on and what it cost, when known. */
  meta?: string | null;
  /** "live" while a take is still rendering; "done" once every take has settled. */
  state: "live" | "done";
  batchId: string;
  testId: string;
  /** The takes are choices of the list around the strip (Studio › Takes' radios): no list of their own. */
  plain?: boolean;
  /** Under the takes: what the strip offers next (a draft's final, components/graphite/DraftFinal.tsx). */
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="gx-batch" aria-label={`${label}: ${name}`} data-testid={testId} data-batch-id={batchId} data-state={state}>
      <div className="gx-batch-head">
        <span className="gx-batch-label">{label}</span>
        <span className="gx-batch-name" title={name}>{name}</span>
        {meta ? <span className="gx-batch-meta">{meta}</span> : null}
      </div>
      <div className="gx-batch-takes" role={plain ? undefined : "list"}>{children}</div>
      {foot}
    </section>
  );
}
