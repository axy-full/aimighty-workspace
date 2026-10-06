"use client";
import { useState } from "react";
import { pressable, type QueueItem } from "@/lib/control-room/queue";
import { exact } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import type { PressOutcome } from "@/lib/control-room/approve";
import { Price, usePriceTitle } from "../Price";
import { ThreadCheckpoint } from "./ThreadCheckpoint";
import { itemLine, SAMPLE_LINE } from "./words";

/**
 * One thing waiting for a person (Atomik frame g, "Waiting for you"): what it
 * is, where and when, then Open · Not now · Approve with its price. Approve
 * sends the item through its own route at its own price; a plan's step opens
 * its Continue instead, priced live. An item this person may not press says
 * who can, and one the balance can't cover offers Top up.
 */
export function ApprovalRow({ item, onApprove, onDecline, onOpen, onTopUp }: {
  item: QueueItem;
  onApprove: (item: QueueItem) => Promise<PressOutcome>;
  onDecline: (item: QueueItem) => Promise<PressOutcome>;
  onOpen: (item: QueueItem) => void;
  onTopUp: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState(false);
  const thread = item.approve?.kind === "thread" ? item.approve : null;
  /* The dollars of the price on the button, on the whole button. */
  const dollars = usePriceTitle(item.price) ?? undefined;
  const short = (item.shortBy ?? 0) > 0;
  /* A held take can't be released while the balance is short; everything else may still be approved, as today. */
  const approvable = pressable(item) && !(short && item.source === "held");

  const press = async (kind: "approve" | "decline") => {
    if (busy) return;
    setBusy(kind); setProblem(null);
    try {
      const outcome = kind === "approve" ? await onApprove(item) : await onDecline(item);
      if (!outcome.ok) setProblem(outcome.reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="cr-row" data-source={item.source} data-open={checkpoint || undefined} data-testid="approval-row" data-item={item.id}>
      <span className="cr-dot" aria-hidden="true" />
      <span className="cr-row-body">
        <span className="cr-row-title">{item.title}</span>
        <span className="cr-row-line">{itemLine(item)}</span>
        {item.note ? <span className="cr-row-note">{item.note}</span> : null}
        {item.why ? <span className="cr-row-why" data-testid="approval-why">{item.why}</span> : null}
        {short ? (
          <span className="cr-row-short" data-testid="approval-short">
            <span>Short by <Price value={exact(item.shortBy)} /></span>
            <button type="button" className="cr-link" onClick={onTopUp} data-testid="approval-top-up">Top up</button>
          </span>
        ) : null}
        {problem ? <span className="cr-row-error" role="alert" data-testid="approval-problem">{problem}</span> : null}
      </span>
      <span className="cr-row-actions">
        <button type="button" className="cr-btn" onClick={() => onOpen(item)} data-testid="approval-open">Open</button>
        {item.sample ? <span className="cr-row-sample">{SAMPLE_LINE}</span> : (<>
          {item.decline && !thread ? (
            <button type="button" className="cr-btn" disabled={busy !== null} onClick={() => void press("decline")} data-testid="approval-not-now">
              {busy === "decline" ? "Setting aside…" : "Not now"}
            </button>
          ) : null}
          {approvable ? (
            <button type="button" className="cr-btn cr-btn--approve" disabled={busy !== null} aria-expanded={thread ? checkpoint : undefined} aria-busy={busy === "approve" || undefined} title={dollars}
              onClick={() => (thread ? setCheckpoint((open) => !open) : void press("approve"))} data-testid="approval-approve"
              {...(thread ? {} : spendAttrsOf(item.price))}>
              {busy === "approve" ? "Approving…" : item.price ? <>Approve · <Price value={item.price} /></> : "Approve"}
            </button>
          ) : null}
        </>)}
      </span>
      {thread && checkpoint ? <ThreadCheckpoint chatId={thread.chatId} productionId={thread.productionId} /> : null}
    </li>
  );
}
