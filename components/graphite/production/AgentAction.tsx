"use client";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentPrice } from "@/lib/production/agent";
import { useMoney } from "@/lib/price";
import type { AgentQuote } from "./use-agent-runs";

/**
 * One priced agent action: "Estimate …" first; with the quote on screen, the
 * button names the ceiling and starts it. A blocked action says why, inline.
 * The ceiling is in the unit the workspace pays in (`price`: "12 cr", or a
 * dollar ceiling where the workspace pays its vendors in dollars).
 */
export function AgentAction({ id, estimateLabel, startLabel, quote, busy, blocked, onEstimate, onStart, onChange, describe, secondary }: {
  id: string; estimateLabel: string; startLabel: (price: string) => string; quote: AgentQuote | null; busy: string; blocked: string | null;
  onEstimate: () => void; onStart: () => void; onChange: () => void; describe?: (quote: AgentQuote, price: string) => string; secondary?: boolean;
}) {
  const { inCredits } = useMoney();
  const price = quote ? agentPrice(quote.value, inCredits) : "";
  const line = quote ? (describe ? describe(quote, price) : `${quote.value.calls} agent steps · ${thinkingModelName(quote.input.model)} · up to ${price}`) : "";
  return (
    <div className="gx-gen-enhance">
      {quote ? (
        <>
          <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(blocked)} onClick={onStart} data-testid={`${id}-start`}>{busy || startLabel(price)}</button>
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
