"use client";
import { useState } from "react";
import { pressable, sortQueue, type QueueItem } from "@/lib/control-room/queue";
import type { PressOutcome } from "@/lib/control-room/approve";
import { shortByWords } from "@/lib/shell/price-words";
import { Price, usePriceTitle } from "../Price";
import { waitingLine } from "./home-model";

/** How many rows Home shows; the rest are in the control room's Approvals. */
export const WAITING_ROWS = 5;

function Row({ item, now, onApprove, onOpen, onTopUp }: {
  item: QueueItem;
  now: number;
  onApprove: (item: QueueItem) => Promise<PressOutcome>;
  onOpen: () => void;
  onTopUp: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const title = usePriceTitle(item.price);
  const thread = item.approve?.kind === "thread";
  const short = (item.shortBy ?? 0) > 0 && item.price && item.price.kind !== "free" ? shortByWords(0, { kind: "exact", credits: item.shortBy! }) : null;
  const canPress = pressable(item) && !thread;
  const press = async () => {
    if (busy) return;
    setBusy(true);
    setProblem("");
    const outcome = await onApprove(item);
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.reason);
  };
  /* Who may press it, when this person may not: the queue's own words. */
  const why = item.needsAdmin && !item.canApprove ? "Needs an admin" : !item.canApprove ? item.why : null;
  return (
    <li className="gx-hm-wait" data-testid="home-waiting-row" data-item={item.id}>
      <span className="gx-hm-wait-dot" aria-hidden="true" />
      <span className="gx-hm-wait-text">
        <span className="gx-hm-wait-title">{item.title}</span>
        <span className="gx-hm-wait-line">{waitingLine(item, now)}</span>
        {item.note ? <span className="gx-hm-wait-line">{item.note}</span> : null}
        {short ? <span className="gx-hm-wait-short" data-testid="home-waiting-short">{short} · <button type="button" className="gx-hm-link" onClick={onTopUp} data-testid="home-waiting-topup">Top up</button></span> : null}
        {problem ? <span className="gx-hm-problem" role="alert" data-testid="home-waiting-problem">{problem}</span> : null}
      </span>
      <span className="gx-hm-wait-actions">
        <button type="button" className="gx-hm-btn" onClick={onOpen} data-testid="home-waiting-open">Open</button>
        {why ? <span className="gx-hm-wait-why" data-testid="home-waiting-why">{why}</span>
          : canPress ? (
            <button type="button" className="gx-hm-btn gx-hm-approve" onClick={() => void press()} disabled={busy || Boolean(short)} aria-busy={busy || undefined}
              title={title ?? undefined} data-testid="home-waiting-approve">
              {busy ? "Approving…" : <span>Approve · <Price value={item.price} /></span>}
            </button>
          ) : null}
      </span>
    </li>
  );
}

/**
 * Waiting for you (the master's Home): what waits for a person across every project, from the one shared
 * queue (stream 8's lib/control-room). Each Approve sends that item alone through its own existing
 * person-only path at its own price; Home never approves in one go. A plan's step is approved with its
 * plan's Continue, so it shows Open only. Nothing waiting: the strip is left out.
 */
export function WaitingStrip({ items, now, onApprove, onOpen, onTopUp, onAll }: {
  items: readonly QueueItem[];
  now: number;
  onApprove: (item: QueueItem) => Promise<PressOutcome>;
  onOpen: (item: QueueItem) => void;
  onTopUp: () => void;
  onAll: () => void;
}) {
  if (!items.length) return null;
  const shown = sortQueue(items).slice(0, WAITING_ROWS);
  return (
    <section className="gx-hm-section gx-hm-waiting" aria-labelledby="gx-hm-waiting" data-testid="home-waiting">
      <div className="gx-hm-head">
        <h2 className="gx-hm-eyebrow" id="gx-hm-waiting">Waiting for you</h2>
        {items.length > shown.length ? <button type="button" className="gx-hm-link" onClick={onAll} data-testid="home-waiting-all">All approvals · {items.length.toLocaleString("en-US")}</button> : null}
      </div>
      <ul className="gx-hm-waits">
        {shown.map((item) => <Row key={item.id} item={item} now={now} onApprove={onApprove} onOpen={() => onOpen(item)} onTopUp={onTopUp} />)}
      </ul>
    </section>
  );
}
