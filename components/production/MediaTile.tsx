"use client";

import { StateDot, STATE_TONE, Waveform, type DotState } from "@/components/ui";
import LazyMedia from "@/components/LazyMedia";

/**
 * The media card of board 7b (design/particl-v2/README.md §6): `--card`,
 * .08, radius 10 (hover .24); a 16:9 well under a .06 hairline with the
 * kind chip at 7px (`TAKE / STILL / AUDIO / MASTER`), the waveform strip
 * on ground for audio, and `↓ 1080P` in the accent, bottom-right, on a
 * master; a body `9px 10px 10px`, 6 apart: the id at 500 12.5px beside the
 * state — a 7px dot and its word in mono at .1em in the state's colour —
 * then `model` and `cost · by` in mono at .08em, muted.
 */
export type MediaItem = {
  id: string; label: string; kind: "take" | "still" | "audio" | "master";
  state: DotState; stateWord: string; url: string | null; poster?: string | null;
  model: string; cost: string; by: string; resolution?: string | null;
};

export default function MediaTile({ m, onOpen }: { m: MediaItem; onOpen?: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex flex-col overflow-hidden rounded-tile border border-border bg-card text-left hover:border-border-hover">
      <span className="relative block aspect-video w-full border-b border-hairline">
        {m.kind === "audio" ? <Waveform /> : m.url ? (
          <LazyMedia url={m.url} kind={m.kind === "still" ? "image" : "video"} className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
        <span className="ui-chip-scrim absolute left-[7px] top-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono text-ink">{m.kind}</span></span>
        {m.kind === "master" && (
          <span className="ui-chip-scrim absolute bottom-[7px] right-[7px] rounded-badge px-[6px] py-[4px]"><span className="ui-mono ui-mono-cost text-accent">↓ {m.resolution ?? "1080p"}</span></span>
        )}
      </span>
      <span className="flex flex-col gap-[6px] px-[10px] pb-[10px] pt-[9px]">
        <span className="flex items-center justify-between gap-[6px]">
          <span className="truncate text-[12.5px] font-medium leading-none text-ink">{m.label}</span>
          <span className={`flex items-center gap-[5px] whitespace-nowrap ui-mono tracking-[.1em] ${STATE_TONE[m.state]}`}>
            <StateDot state={m.state} size={7} />{m.stateWord}
          </span>
        </span>
        <span className="flex justify-between whitespace-nowrap ui-mono ui-mono-cost text-ink-muted">
          <span className="truncate">{m.model}</span><span>{m.cost} · {m.by}</span>
        </span>
      </span>
    </button>
  );
}
