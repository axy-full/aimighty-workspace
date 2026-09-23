"use client";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import type { AgentQuote } from "./use-agent-runs";

/**
 * One priced agent action: "Estimate …" first; with the quote on screen, the
 * button names the ceiling and starts it. A blocked action says why, inline.
 */
export function AgentAction({ id, estimateLabel, startLabel, quote, busy, blocked, onEstimate, onStart, onChange, describe, secondary }: {
  id: string; estimateLabel: string; startLabel: (credits: string) => string; quote: AgentQuote | null; busy: string; blocked: string | null;
  onEstimate: () => void; onStart: () => void; onChange: () => void; describe?: (quote: AgentQuote) => string; secondary?: boolean;
}) {
  const credits = quote ? quote.value.estimateCredits.toLocaleString() : "";
  const line = quote ? (describe ? describe(quote) : `${quote.value.calls} agent steps · ${thinkingModelName(quote.input.model)} · up to ${credits} credits${quote.value.estimateUsd != null ? ` · $${quote.value.estimateUsd.toFixed(4)} ceiling` : ""}`) : "";
  return (
    <div className="gx-gen-enhance">
      {quote ? (
        <>
          <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(blocked)} onClick={onStart} data-testid={`${id}-start`}>{busy || startLabel(credits)}</button>
          <button type="button" className="gx-hbtn" onClick={onChange}>Change</button>
          <span className="gx-hint" data-testid={`${id}-quote`}>{line}</span>
        </>
      ) : (
        <button type="button" className={secondary ? "gx-hbtn" : "gx-primary"} disabled={Boolean(busy) || Boolean(blocked)} aria-describedby={blocked ? `${id}-blocked` : undefined} onClick={onEstimate} data-testid={`${id}-estimate`}>{busy || estimateLabel}</button>
      )}
      {blocked && !quote ? <span className="gx-reason" id={`${id}-blocked`} data-testid={`${id}-blocked`}>{blocked}</span> : null}
    </div>
  );
}
