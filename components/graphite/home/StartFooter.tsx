"use client";
import { Price, usePriceTitle } from "../Price";
import { upTo } from "@/lib/shell/price-words";
import type { Thinking } from "./use-thinking-price";

/**
 * The box's last row (the master's Home): Atomik's thinking line and **Start · up to N cr**, the one primary
 * button on Home. The figure is the server's (`thinking`, or a newer one the server gave after the project
 * was made); without one there is no price, so Start can't be pressed and the line says why.
 */
export function StartFooter({ thinking, figure, busy, disabled, onStart, onRetry, problem }: {
  thinking: Thinking;
  /** The figure on the button: the server's, possibly a newer one for this project. */
  figure: number | null;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onRetry: () => void;
  problem: string;
}) {
  const price = figure != null ? upTo(figure) : null;
  const title = usePriceTitle(price);
  const line = thinking.state === "off" ? "Atomik isn't on for this workspace yet."
    : thinking.state === "unpriced" ? "Atomik's thinking can't be priced right now."
    : thinking.state === "error" ? thinking.message
    : thinking.state === "loading" && !price ? "Pricing Atomik's thinking…"
    : null;
  const retry = thinking.state === "unpriced" || thinking.state === "error";
  return (
    <div className="gx-hm-foot" data-testid="home-start-row">
      <span className="gx-hm-thinking" data-testid="home-thinking">
        {line ?? <span>Atomik’s thinking may cost <Price value={price} testId="home-thinking-price" /></span>}
        {retry ? <button type="button" className="gx-hm-link gx-hm-retry" onClick={onRetry} data-testid="home-thinking-retry">Try again</button> : null}
      </span>
      <button type="button" className="gx-hm-start" onClick={onStart} disabled={disabled || busy || !price} aria-busy={busy || undefined}
        title={title ?? undefined} data-testid="home-start">
        {busy ? "Starting…" : price ? <span>Start · <Price value={price} /></span> : "Start"}
      </button>
      {problem ? <p className="gx-hm-problem gx-hm-foot-problem" role="alert" data-testid="home-start-problem">{problem}</p> : null}
    </div>
  );
}
