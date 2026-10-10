"use client";
import { useState } from "react";
import { pressable, sortQueue, type QueueItem } from "@/lib/control-room/queue";
import type { PressOutcome } from "@/lib/control-room/approve";
import { spendAttrsOf } from "@/lib/spend";
import { knownQuote } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";

/**
 * Waiting for you (docs/redesign/inventory.md § 5.9 · 1): one 44 px strip over the wall. "Waiting for you", the count,
 * then one item (two from 1400 px), each its title, where it is, and its one action at its own price from the shared
 * approvals queue (lib/control-room): Approve sends that item alone through its own person-only path. "+N more" opens
 * every approval; × hides the strip until something new waits. Nothing waiting: no strip.
 */
export function WaitingStrip({ items, shown, onApprove, onOpen, onMore, onHide }: {
  items: readonly QueueItem[];
  /** How many items fit inline. */
  shown: number;
  onApprove: (item: QueueItem) => Promise<PressOutcome>;
  onOpen: (item: QueueItem) => void;
  onMore: () => void;
  onHide: () => void;
}) {
  if (!items.length) return null;
  const sorted = sortQueue(items);
  const inline = sorted.slice(0, Math.max(1, shown));
  const more = sorted.length - inline.length;
  return (
    <section className="v12-hm-wait" aria-label="Waiting for you" data-testid="v12-home-waiting">
      <h2 className="v12-hm-wait-title">Waiting for you</h2>
      <span className="v12-hm-wait-count" data-testid="v12-home-waiting-count">{items.length.toLocaleString("en-US")}</span>
      <ul className="v12-hm-wait-items">
        {inline.map((item) => <Item key={item.id} item={item} onApprove={onApprove} onOpen={() => onOpen(item)} />)}
      </ul>
      {more > 0 ? <button type="button" className="v12-hm-chip-btn" onClick={onMore} title="See everything waiting for you" data-testid="v12-home-waiting-more">+{more} more</button> : null}
      <button type="button" className="v12-hm-wait-x" onClick={onHide} title="Hide for now" aria-label="Hide for now" data-testid="v12-home-waiting-hide">×</button>
    </section>
  );
}

function Item({ item, onApprove, onOpen }: { item: QueueItem; onApprove: (item: QueueItem) => Promise<PressOutcome>; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /* A plan's step is approved with its plan's Continue; a short balance tops up first: those open instead. */
  const canPress = pressable(item) && item.approve?.kind !== "thread" && !((item.shortBy ?? 0) > 0);
  const where = [item.project.name, item.where].filter(Boolean).join(" · ");
  const press = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const outcome = await onApprove(item);
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.reason);
  };
  const why = item.needsAdmin && !item.canApprove ? "Needs an admin" : !item.canApprove ? item.why : null;
  return (
    <li className="v12-hm-wait-item" data-testid="v12-home-waiting-item" data-item={item.id}>
      <button type="button" className="v12-hm-wait-open" onClick={onOpen} title={problem || why || "Open it where it waits"} data-testid="v12-home-waiting-open">
        <span className="v12-hm-dot" data-tone={problem ? "problem" : "waiting"} aria-hidden="true" />
        <span className="v12-hm-wait-name">{item.title}</span>
        {where ? <span className="v12-hm-wait-where">· {where}</span> : null}
      </button>
      {canPress ? (
        <button type="button" className="v12-hm-chip-btn" onClick={() => void press()} disabled={busy} aria-busy={busy || undefined}
          data-testid="v12-home-waiting-approve" {...spendAttrsOf(item.price)}>
          {busy ? "Approving…" : <span>Approve · <Price quote={knownQuote(item.price)} /></span>}
        </button>
      ) : (
        <button type="button" className="v12-hm-chip-btn" onClick={onOpen} data-testid="v12-home-waiting-action">Open</button>
      )}
      {problem ? <span className="v12-hm-sr" role="alert">{problem}</span> : null}
    </li>
  );
}
