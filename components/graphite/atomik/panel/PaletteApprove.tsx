"use client";
import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { selectBatch, type QueueItem } from "@/lib/control-room/queue";
import { priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { useWorkspace } from "@/lib/workspace/state";
import { Price, usePriceTitle } from "../../Price";

/**
 * ⌘K's "approve everything under N cr" (Atomik frames d and e; README § 4 "Confirm · approve N items"). Atomik
 * lists what the words cover from the one approvals queue (stream 8, lib/control-room): project · step · price, the
 * items an admin must press (left out), and the total. Only the person's tap on the button approves: it sends each
 * listed item through its own existing person-only path at its own price, one at a time, and stops at the first
 * refusal (lib/control-room/approve.ts). Enter only shows the list. Plan steps keep their own Continue.
 *
 * Lead decision 30: this button approves spending in one press, so it merges only after the owner has seen it.
 */
export function PaletteApproveCard({ under, onDone, enterRef }: { under: number; onDone: () => void; enterRef: MutableRefObject<(() => void) | null> }) {
  const approvals = useApprovals();
  const { toast } = useWorkspace();
  const batch = useMemo(() => selectBatch(approvals.items, under), [approvals.items, under]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const totalWords = priceWords(batch.total);
  const title = usePriceTitle(batch.total);
  /* Enter shows this list; it never approves. */
  useEffect(() => { enterRef.current = null; });
  const confirm = async () => {
    if (busy || !batch.items.length) return;
    setBusy(true);
    setRefusal(null);
    const result = await approvals.approveBatch(batch.items);
    setBusy(false);
    const n = result.approved.length;
    if (result.refused) {
      setRefusal(`Approved ${n} of ${batch.items.length} · ${result.refused.item.title}: ${result.refused.reason}`);
      return;
    }
    toast(`Approved ${n} ${n === 1 ? "item" : "items"}${totalWords ? ` · ${totalWords}` : ""}`);
    onDone();
  };
  const loading = approvals.status === "loading";
  const empty = !loading && !batch.items.length;
  return (
    <div className="ak-pcard" data-testid="palette-approve-card">
      <span className="ak-eyebrow ak-accent">Atomik</span>
      <strong className="ak-pcard-title">{empty ? `Nothing under ${under} cr is waiting` : `Approve everything under ${under} cr`}</strong>
      {loading ? <p className="ak-pcard-line" role="status">Reading what is waiting…</p> : null}
      {approvals.status === "error" ? (
        <p className="ak-pcard-line" role="alert">{approvals.error} <button type="button" className="ak-link" onClick={() => void approvals.refresh()}>Try again</button></p>
      ) : null}
      {batch.items.length ? <div className="ak-prows" data-testid="palette-approve-rows">{batch.items.map((item) => <Row key={item.id} item={item} />)}</div> : null}
      {batch.adminOut.length ? (
        <div className="ak-prows" data-testid="palette-approve-admin">
          <span className="ak-eyebrow ak-warn">Needs an admin</span>
          {batch.adminOut.map((item) => <Row key={item.id} item={item} />)}
          <span className="ak-pcard-note">Over the workspace’s rule for a shot, so an admin presses these · left out of this approval</span>
        </div>
      ) : null}
      {batch.inPlan.length ? (
        <span className="ak-pcard-note" data-testid="palette-approve-in-plan">
          {batch.inPlan.length} {batch.inPlan.length === 1 ? "plan step waits" : "plan steps wait"} for its plan’s own Continue, in Approvals
        </span>
      ) : null}
      {totalWords ? <div className="ak-ptotal" data-testid="palette-approve-total">Total · {totalWords}</div> : null}
      {refusal ? <p className="ak-pcard-line ak-problem" role="alert" data-testid="palette-approve-refusal">{refusal}</p> : null}
      <div className="ak-pcard-foot">
        <span className="ak-pcard-note">Only you approve spend. Enter shows this list; the button approves.</span>
        {batch.items.length && totalWords ? (
          <button type="button" className="ak-btn ak-btn-primary" disabled={busy} aria-busy={busy || undefined} title={title ?? undefined} onClick={() => void confirm()} data-testid="palette-approve-confirm" {...spendAttrsOf(batch.total)}>
            {busy ? "Approving…" : `Approve ${batch.items.length} ${batch.items.length === 1 ? "item" : "items"} · ${totalWords}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Row({ item }: { item: QueueItem }) {
  return (
    <div className="ak-prow" data-testid="palette-approve-row">
      <span className="ak-prow-project">{item.project.name ?? "No project"}</span>
      <span className="ak-prow-step">{item.title}</span>
      <Price value={item.price} className="ak-mono" />
    </div>
  );
}
