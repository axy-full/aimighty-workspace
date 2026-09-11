import { creditsNumber, useMoney } from "@/lib/price";
import Mono from "./Mono";

/**
 * Spent of cap (design/particl-v2/README.md §3, §6), in its three places,
 * each exactly as the boards draw it. The bar is 3px, radius 2, on a .1
 * track; the fill is ink — spend is a fact, not progress, and the accent
 * is for done. Past the cap the bar simply fills; the number says how far.
 *
 *   header  `228 of 400 cr` — Outfit 500 14px, the figure 600, the rest
 *           `--ink-body`; a 180px bar, right-aligned (board 10a)
 *   row     the same line at 500 13px, all in ink, over a 160px bar (board 7a)
 *   tile    `228 / 400 CR` and `57%` in mono, .08em, the percentage muted,
 *           over a full-width bar (board 7a project tiles)
 *   phone   the header's line at 500 13px (the figure 600, the rest
 *           `--ink-body`) over a 110px bar, 5 apart (boards M2, M3)
 *
 * The figures are in the workspace's unit (§1: prices are read, never
 * typed): whole credits with `cr` after them, or — for a workspace that
 * pays its vendors in dollars — `$0.13 of $2.86`, with no `cr`.
 */
type Props = {
  spent: number;
  cap: number;
  placement?: "header" | "row" | "tile" | "phone";
  className?: string;
};

export default function CapBar({ spent, cap, placement = "header", className = "" }: Props) {
  const money = useMoney();
  const num = (n: number) => (money.inCredits ? creditsNumber(n) : money.price(n));
  const unit = money.inCredits ? " cr" : "";
  const pct = cap > 0 ? Math.max(0, Math.round((spent / cap) * 100)) : 0;
  const bar = (
    <span className="block h-[3px] overflow-hidden rounded-[2px] bg-[rgba(245,246,248,.1)]" style={placement === "tile" ? undefined : { width: placement === "header" ? 180 : placement === "phone" ? 110 : 160 }}>
      <span className="block h-full bg-ink" style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
  const meter = {
    role: "meter" as const, "aria-valuemin": 0, "aria-valuemax": cap, "aria-valuenow": spent,
    "aria-label": `${num(spent)} of ${num(cap)}${money.inCredits ? " credits" : ""} spent`,
  };
  if (placement === "tile") {
    return (
      <span {...meter} className={`flex flex-col gap-[5px] ${className}`}>
        <span className="flex justify-between">
          <Mono cost tone="ink">{num(spent)} / {num(cap)}{unit}</Mono>
          <Mono cost>{pct}%</Mono>
        </span>
        {bar}
      </span>
    );
  }
  return (
    <span {...meter} className={`flex flex-col items-end ${placement === "phone" ? "gap-[5px]" : "gap-[6px]"} ${className}`}>
      {placement === "phone" ? (
        <span className="text-[13px] font-medium leading-none text-ink">
          <span className="font-semibold">{num(spent)}</span> <span className="text-ink-body">of {num(cap)}{unit}</span>
        </span>
      ) : placement === "header" ? (
        <span className="text-[14px] font-medium leading-none text-ink">
          <span className="font-semibold">{num(spent)}</span> <span className="text-ink-body">of {num(cap)}{unit}</span>
        </span>
      ) : (
        <span className="text-[13px] font-medium leading-none text-ink">{num(spent)} of {num(cap)}{unit}</span>
      )}
      {bar}
    </span>
  );
}
