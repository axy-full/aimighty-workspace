"use client";
import { useMemo, useState } from "react";
import { BATCH_UNDER_DEFAULT, cleanUnder, selectBatch, type QueueItem } from "@/lib/control-room/queue";
import { exact } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { BatchResult } from "@/lib/control-room/approve";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { Price, usePriceTitle } from "../Price";

/**
 * "Approve in one go" (Atomik frame g; README § 4 "Confirm · approve N
 * items"): everything under a figure, listed with each price and the total,
 * confirmed by a person's one tap. There is no batch route: the tap sends each
 * listed item through its own route at its own price, one at a time, and the
 * first refusal stops it. Left out: items over the per-shot rule (an admin
 * presses those), a plan's steps (their own Continue), proposed builds, and
 * anything this person may not press.
 */
export function BatchApprove({ items, run }: {
  items: readonly QueueItem[];
  run: (items: readonly QueueItem[], onStep: (done: QueueItem, at: number) => void) => Promise<BatchResult>;
}) {
  /* The sample workspace spends nothing: there is no approving in one go there. */
  const spendOff = useSampleWorkspace();
  const [text, setText] = useState(String(BATCH_UNDER_DEFAULT));
  const under = cleanUnder(text);
  const batch = useMemo(() => selectBatch(items, under), [items, under]);
  const dollars = usePriceTitle(batch.total) ?? undefined;
  const [busy, setBusy] = useState<{ done: number; of: number } | null>(null);
  const [result, setResult] = useState<{ approved: number; of: number; refused: { title: string; reason: string } | null } | null>(null);

  const confirm = async () => {
    if (busy || !batch.items.length) return;
    const listed = batch.items;
    setResult(null);
    setBusy({ done: 0, of: listed.length });
    try {
      const out = await run(listed, (_done, at) => setBusy({ done: at + 1, of: listed.length }));
      setResult({ approved: out.approved.length, of: listed.length, refused: out.refused ? { title: out.refused.item.title, reason: out.refused.reason } : null });
    } finally {
      setBusy(null);
    }
  };

  if (spendOff) return null;
  return (
    <div className="cr-block" data-testid="approve-in-one-go">
      <span className="cr-eyebrow">Approve in one go</span>
      <p className="cr-text">Atomik lists what a batch covers and its total; you confirm with one tap. Atomik never approves on its own.</p>
      <label className="cr-label">Everything under · credits
        <input className="cr-input" type="number" inputMode="numeric" min={1} step={1} value={text} onChange={(e) => setText(e.target.value)} aria-label="Everything under, in credits" data-testid="batch-under" />
      </label>
      <div className="cr-strong" data-testid="batch-line">
        {batch.items.length
          ? batch.items.map((item, i) => <span key={item.id}>{i ? " · " : ""}{item.title} (<Price value={item.price} />)</span>)
          : <>Nothing under <Price value={exact(under)} /> is waiting</>}
      </div>
      {batch.adminOut.length ? (
        <p className="cr-text" data-testid="batch-admin-out">Needs an admin, left out: {batch.adminOut.map((item) => item.title).join(" · ")}</p>
      ) : null}
      {batch.inPlan.length ? (
        <p className="cr-text" data-testid="batch-in-plan">Approved in their plans, left out: {batch.inPlan.map((item) => item.title).join(" · ")}</p>
      ) : null}
      <button type="button" className="cr-primary" disabled={!batch.items.length || busy !== null} aria-busy={busy !== null || undefined} title={dollars} onClick={() => void confirm()} data-testid="batch-confirm"
        {...(batch.items.length ? spendAttrsOf(batch.total) : {})}>
        {busy ? `Approving ${Math.min(busy.done + 1, busy.of)} of ${busy.of}…`
          : batch.items.length ? <>Confirm · approve {batch.items.length} {batch.items.length === 1 ? "item" : "items"} · <Price value={batch.total} /></>
          : "Nothing to approve"}
      </button>
      {result ? (
        <p className="cr-result" role="status" data-tone={result.refused ? "refused" : undefined} data-testid="batch-result">
          {result.refused
            ? `Approved ${result.approved} of ${result.of}. Stopped at ${result.refused.title}: ${result.refused.reason}`
            : `Approved ${result.approved} ${result.approved === 1 ? "item" : "items"}.`}
        </p>
      ) : null}
    </div>
  );
}
