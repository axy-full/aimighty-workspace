"use client";
import { useEffect, useRef, useState } from "react";
import { spendAttrsOf } from "@/lib/spend";
import { exact, priceWords, type PriceValue } from "@/lib/shell/price-words";
import { usePriceTitle } from "@/components/graphite/Price";
import type { CutoutState } from "@/components/workspace/rig/use-cutouts";
import type { BoardCtx } from "../types";
import type { CutoutView } from "./cutout-model";

/*
 * Cut-out on a Cast card with a still (gap screens, Cut-out). The existing path, unchanged in money terms: the still tool
 * quotes the price for free (RigContext.quoteCutout), a person's press sends it at exactly that price
 * (RigContext.startCutout; a price that moved is asked again, never sent), and the finished cut-out is filed as a new version of
 * the card's source with the original kept (lib/workspace/cutout.ts). Nothing runs on its own, and Atomik never presses it.
 *
 * "Nothing billed" is said only when the job's own settled figure is 0; a failure with no figure says where its charge, if any, is.
 */

type Quote = { key: string; price: PriceValue | null; error?: string };

export function CutoutAction({ ctx, nodeId, view, showing, onShow, primary = false }: {
  ctx: BoardCtx; nodeId: string; view: CutoutView; showing: "before" | "after"; onShow: (which: "before" | "after") => void;
  /** The card is selected: its one action is drawn filled, as the design draws the card in focus. */
  primary?: boolean;
}) {
  const { rig } = ctx;
  const node = ctx.project.nodes.find((n) => n.id === nodeId);
  const run: CutoutState | undefined = rig.cutouts[nodeId];
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const key = `${nodeId}:${node?.assetId ?? ""}`;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const quoting = useRef("");
  const wants = !view.problem && !view.done && !blocked && run?.phase !== "running" && Boolean(node);
  const current = quote?.key === key ? quote : null;

  /* A free read of the price, once per source (and again after Try again or a failed run). */
  useEffect(() => {
    if (!wants || !node) return;
    const id = `${key}:${round}`;
    if (quoting.current === id) return;
    quoting.current = id;
    let live = true;
    void rig.quoteCutout(node).then((answer) => {
      if (!live) return;
      setQuote("credits" in answer ? { key, price: exact(answer.credits) } : { key, price: null, error: answer.reason });
    });
    return () => { live = false; quoting.current = ""; };
    // The quote is for this card's source; rig.quoteCutout is stable per scope and draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wants, key, round]);

  const price = current?.price ?? null;
  const title = usePriceTitle(price);
  const words = priceWords(price);

  async function press() {
    if (!node || !price || price.kind !== "exact" || busy) return;
    setBusy(true); setProblem(null);
    try {
      const outcome = await rig.startCutout(node, price.credits);
      if (outcome.state === "repriced") { setQuote({ key, price: exact(outcome.credits) }); setProblem(outcome.reason); }
      else if (outcome.state === "refused") setProblem(outcome.reason);
    } finally { setBusy(false); }
  }

  if (run?.phase === "running") {
    return (
      <div className="gx-co" data-testid="cutout-running" data-phase="running">
        <span className="gx-co-state" role="status"><i aria-hidden="true" />{run.held ? "Waiting for a render slot" : "Cutting out the background"}</span>
        <span className="gx-co-bar" role="progressbar" aria-label="Cutting out" data-indeterminate=""><span /></span>
      </div>
    );
  }
  if (view.done) {
    return (
      <div className="gx-co" data-testid="cutout-done" data-phase="done">
        <span className="gx-co-state" data-tone="done"><i aria-hidden="true" />Cut-out · v2 · background removed</span>
        <div className="gx-co-row" role="group" aria-label="Before and after">
          {(["before", "after"] as const).map((which) => (
            <button key={which} type="button" className="gx-cast-btn gx-co-chip nodrag nopan" aria-pressed={showing === which}
              onClick={(e) => { e.stopPropagation(); onShow(which); }} onDoubleClick={(e) => e.stopPropagation()} data-testid={`cutout-${which}`}>
              {which === "before" ? "Before" : "After"}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (view.problem) return null;
  const failed = run?.phase === "failed" ? run : null;
  const billed = failed ? (failed.settled === 0 ? "Nothing billed" : failed.settled != null ? `${failed.settled} cr settled` : "Its charge, if any, is in Activity") : null;
  const label = failed ? "Retry" : "Cut-out";
  return (
    <div className="gx-co" data-testid="cutout-action" data-phase={failed ? "failed" : "idle"}>
      {failed ? <span className="gx-co-state" data-tone="failed" role="status"><i aria-hidden="true" />{failed.reason} · {billed}</span> : null}
      <div className="gx-co-row">
        <button type="button" className="gx-cast-btn gx-co-go nodrag nopan" title={title ?? blocked ?? undefined} aria-busy={busy || undefined} data-primary={primary || undefined}
          {...spendAttrsOf(price)} disabled={Boolean(blocked) || busy || !price}
          onClick={(e) => { e.stopPropagation(); void press(); }} onDoubleClick={(e) => e.stopPropagation()} data-testid="cutout-go">
          {words ? `${label} · ${words}` : label}
        </button>
        {current?.error ? (
          <button type="button" className="gx-cast-btn nodrag nopan" onClick={(e) => { e.stopPropagation(); setQuote(null); setRound((n) => n + 1); }} data-testid="cutout-try-again">Try again</button>
        ) : null}
      </div>
      {problem ? <span className="gx-co-why" role="alert">{problem}</span> : current?.error ? <span className="gx-co-why" role="status">The price could not be read.</span> : null}
    </div>
  );
}
