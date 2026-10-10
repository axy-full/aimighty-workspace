"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { pressable, sortQueue, type QueueItem } from "@/lib/control-room/queue";
import type { PressOutcome } from "@/lib/control-room/approve";
import { spendAttrsOf } from "@/lib/spend";
import { knownQuote } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";
import { Tooltip } from "@/components/v12/ui/Tooltip";
import { waitingLevels, waitingWords, type WaitingLevel } from "@/lib/v12/home";

/**
 * Waiting for you (docs/redesign/inventory.md § 5.9 · 1): one 44 px strip over the wall. "Waiting for you", the count,
 * then one item (two from 1400 px, when they fit), each its title, where it is, and its one action at its own price from
 * the shared approvals queue (lib/control-room): Approve sends that item alone through its own person-only path. "+N
 * more" opens every approval; × hides the strip until something new waits. Nothing waiting: no strip.
 *
 * What fits is measured, not guessed from the window: names are cut at a word (lib/v12/home.ts waitingLevels), then an
 * item moves to "+N more", until the items and their actions sit whole in the strip. A name is never cut by the stylesheet.
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
  const sorted = useMemo(() => sortQueue(items), [items]);
  const list = useRef<HTMLUListElement>(null);
  const levels = useMemo(() => waitingLevels(Math.min(shown, sorted.length) || 1), [shown, sorted.length]);
  /* The level in use: from the roomiest down, one step each time the items overflow the strip. A different list, a different
     number of items or a different strip width starts again from the roomiest (the key). */
  const [tick, setTick] = useState(0);
  const key = `${tick}:${levels.length}:${sorted.map((item) => item.id).join("|")}`;
  const [fit, setFit] = useState({ key, level: 0 });
  const at = Math.min(fit.key === key ? fit.level : 0, levels.length - 1);
  const use: WaitingLevel = levels[at];
  const has = sorted.length > 0;
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    /* Refit before the next paint (flushSync), from the window's own resize as well as the list's: the strip never shows
       an action cut off for a frame, and a tooltip's extra render cannot make it late. */
    const refit = () => { if (el.clientWidth !== width) { width = el.clientWidth; flushSync(() => setTick((n) => n + 1)); } };
    const seen = new ResizeObserver(refit);
    seen.observe(el);
    window.addEventListener("resize", refit);
    return () => { seen.disconnect(); window.removeEventListener("resize", refit); };
  }, [has]);
  /* After every render: still too wide, one level barer (it ends at the barest level, so it cannot loop). */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- measures the DOM after each render on purpose
  useLayoutEffect(() => {
    const el = list.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && at < levels.length - 1) setFit({ key, level: at + 1 });
  });
  /* A web font arriving changes every width. */
  useEffect(() => { void document.fonts?.ready.then(() => setTick((n) => n + 1)); }, []);
  if (!items.length) return null;
  const inline = sorted.slice(0, use.shown);
  const more = sorted.length - inline.length;
  return (
    <section className="v12-hm-wait" aria-label="Waiting for you" data-testid="v12-home-waiting">
      <h2 className="v12-hm-wait-title">Waiting for you</h2>
      <span className="v12-hm-wait-count" data-testid="v12-home-waiting-count">{items.length.toLocaleString("en-US")}</span>
      <ul className="v12-hm-wait-items" ref={list}>
        {inline.map((item) => <Item key={item.id} item={item} level={use} onApprove={onApprove} onOpen={() => onOpen(item)} />)}
      </ul>
      {more > 0 ? <button type="button" className="v12-hm-chip-btn" onClick={onMore} title="See everything waiting for you" data-testid="v12-home-waiting-more">+{more} more</button> : null}
      <Tooltip name="Hide for now" named>
        <button type="button" className="v12-hm-wait-x" onClick={onHide} aria-label="Hide for now" data-testid="v12-home-waiting-hide">×</button>
      </Tooltip>
    </section>
  );
}

function Item({ item, level, onApprove, onOpen }: { item: QueueItem; level: WaitingLevel; onApprove: (item: QueueItem) => Promise<PressOutcome>; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  /* A plan's step is approved with its plan's Continue; a short balance tops up first: those open instead. */
  const canPress = pressable(item) && item.approve?.kind !== "thread" && !((item.shortBy ?? 0) > 0);
  const where = [item.project.name, item.where].filter(Boolean).join(" · ");
  const words = waitingWords({ title: item.title, where }, level);
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
      <button type="button" className="v12-hm-wait-open" onClick={onOpen} title={problem || why || "Open it where it waits"} aria-label={`${item.title}${where ? ` · ${where}` : ""}`} data-testid="v12-home-waiting-open">
        <span className="v12-hm-dot" data-tone={problem ? "problem" : "waiting"} aria-hidden="true" />
        <span className="v12-hm-wait-name">{words.name}</span>
        {words.where ? <span className="v12-hm-wait-where">· {words.where}</span> : null}
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
