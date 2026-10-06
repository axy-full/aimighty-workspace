"use client";
import { spendAttrsOf } from "@/lib/spend";
import { Price, usePriceTitle } from "../Price";
import { upTo } from "@/lib/shell/price-words";
import type { Thinking } from "./use-thinking-price";

/**
 * The box's last row (the master's Home): Atomik's thinking line and **Start · up to N cr**, the one primary
 * button on Home. The figure is the server's (`thinking`, or a newer one the server gave after the project
 * was made); without one there is no price, so Start can't be pressed and the line says why. In the sample workspace
 * (`off`, the sample's line) nothing spends: Start is disabled, the line is the sample's, and no price is shown.
 */
export function StartFooter({ thinking, figure, busy, disabled, onStart, onRetry, problem, off = null }: {
  thinking: Thinking;
  /** The figure on the button: the server's, possibly a newer one for this project. */
  figure: number | null;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onRetry: () => void;
  problem: string;
  /** The sample's line when this is the sample workspace: Start is not offered. */
  off?: string | null;
}) {
  const price = figure != null && !off ? upTo(figure) : null;
  const title = usePriceTitle(price);
  const line = off ? off
    : thinking.state === "off" ? "Atomik isn't on for this workspace yet."
    : thinking.state === "unpriced" ? "Atomik's thinking can't be priced right now."
    : thinking.state === "error" ? thinking.message
    : thinking.state === "loading" && !price ? "Pricing Atomik's thinking…"
    : null;
  const retry = !off && (thinking.state === "unpriced" || thinking.state === "error");
  return (
    <div className="gx-hm-foot" data-testid="home-start-row">
      <span className="gx-hm-thinking" data-testid="home-thinking">
        {line ?? <span>Atomik’s thinking may cost <Price value={price} testId="home-thinking-price" /></span>}
        {retry ? <button type="button" className="gx-hm-link gx-hm-retry" onClick={onRetry} data-testid="home-thinking-retry">Try again</button> : null}
      </span>
      <button type="button" className="gx-hm-start" onClick={onStart} disabled={disabled || busy || !price} aria-busy={busy || undefined}
        title={off ?? title ?? undefined} data-testid="home-start" {...(off ? { "data-spend": "unpriced" as const } : spendAttrsOf(price))}>
        {busy ? "Starting…" : price ? <span>Start · <Price value={price} /></span> : "Start"}
      </button>
      {problem ? <p className="gx-hm-problem gx-hm-foot-problem" role="alert" data-testid="home-start-problem">{problem}</p> : null}
    </div>
  );
}
