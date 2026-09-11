import type { ReactNode } from "react";
import StateDot, { STATE_TONE, type DotState } from "./StateDot";
import Mono from "./Mono";
import Loader, { LOADER_SIZES } from "@/components/atomik/Loader";

/**
 * Media card (design/particl-v2/README.md §3), exactly the shot card of
 * board 10a: `--card`, 1px `--border`, radius 12; a 16:9 well with a .06
 * hairline beneath it and the ID chip top-left and state chip top-right
 * (`rgba(11,13,17,.85)`, radius 4, `4px 6px`, mono; the state's word in
 * its state's colour beside a 7px dot); a body `10px 12px 0` with the
 * title at Outfit 400 13.5px/1.35 clamped to two lines and the setup line
 * at 400 12.5px/1.3 `--ink-body`; and the split footer — PLAN left,
 * RENDERS right, `9px 12px`, mono labels muted, mono values at .08em.
 *
 * The well takes whatever the caller renders: a `LazyMedia` poster, an
 * `<img>`, a `Waveform`, or a `Placeholder` while media is not wired. With
 * nothing in it the well is transparent under `emptyLabel`, as 10a draws
 * an empty shot; while a take arrives (`loading`, board 11a) it is ground
 * with the 36px ring and nothing else — no skeleton. The card does not
 * fetch and does not guess.
 */
type Props = {
  id: string;
  state?: DotState;
  /** The state's word, uppercase in mono (`PICKED`, `NO TAKE`). */
  stateLabel?: ReactNode;
  well: ReactNode;
  /** Centred in the well when there is nothing to show (`NO TAKE YET`). */
  emptyLabel?: ReactNode;
  /** A take on its way: the well goes to ground with the 36px ring (11a). */
  loading?: boolean;
  title?: ReactNode;
  setup?: ReactNode;
  footer?: { plan: ReactNode; renders: ReactNode; rendersMuted?: boolean };
  className?: string;
};

export default function MediaCard({ id, state, stateLabel, well, emptyLabel, loading = false, title, setup, footer, className = "" }: Props) {
  return (
    <article className={`flex flex-col overflow-hidden rounded-card border border-border bg-card ${className}`}>
      <div className="relative aspect-video border-b border-hairline">
        {well}
        {loading && <span className="absolute inset-0 flex items-center justify-center bg-ground"><Loader size={LOADER_SIZES.well} /></span>}
        {emptyLabel && !loading && <span className="absolute inset-0 flex items-center justify-center"><Mono>{emptyLabel}</Mono></span>}
        <span className="ui-chip-scrim absolute left-[8px] top-[8px] rounded-badge px-[6px] py-[4px]"><Mono tone="ink">{id}</Mono></span>
        {(state || stateLabel) && (
          <span className={`ui-chip-scrim absolute right-[8px] top-[8px] flex items-center gap-[6px] rounded-badge px-[6px] py-[4px] ${state ? STATE_TONE[state] : "text-ink-muted"}`}>
            {state && <StateDot state={state} size={7} />}
            <span className="ui-mono">{stateLabel}</span>
          </span>
        )}
      </div>
      {(title || setup) && (
        <div className="flex flex-1 flex-col gap-[8px] px-[12px] pt-[10px]">
          {title && <span className="line-clamp-2 min-h-[36px] text-[13.5px] leading-[1.35] text-ink">{title}</span>}
          {setup && <span className="truncate text-[12.5px] leading-[1.3] text-ink-body">{setup}</span>}
        </div>
      )}
      {footer && (
        <div className="mt-[10px] grid grid-cols-[1fr_1fr] border-t border-border">
          <span className="flex flex-col gap-[5px] border-r border-border px-[12px] py-[9px]">
            <Mono>Plan</Mono>
            <Mono cost tone="ink">{footer.plan}</Mono>
          </span>
          <span className="flex flex-col gap-[5px] px-[12px] py-[9px]">
            <Mono>Renders</Mono>
            <Mono cost tone={footer.rendersMuted ? "muted" : "ink"}>{footer.renders}</Mono>
          </span>
        </div>
      )}
    </article>
  );
}
