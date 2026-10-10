"use client";
import { useRef, useState } from "react";
import { Popover } from "@/components/v12/ui/Popover";
import { useToast } from "@/components/v12/ui/Toast";
import { roundBadge, roundDate, whatChangedText, type BoardRound } from "@/lib/v12/rounds";
import "./rounds.css";

/** Copies the what-changed words, and says so. */
export function useCopyWhatChanged(board: string, round: BoardRound | null, shots: number | undefined) {
  const toast = useToast();
  return async () => {
    if (!round) return;
    const text = whatChangedText(board, round, shots);
    try { await navigator.clipboard.writeText(text); toast({ text: "Copied · paste it into WhatsApp or email" }); }
    catch { toast({ text: "It could not be copied here. Select the list and copy it." }); }
  };
}

/**
 * The stage header's Round badge ("Round 2 · 3 changed", prototype L837, L354): the list of what changed, as the client's reply
 * asked for it, and the words to paste into WhatsApp or email. The MP4 with the round burned in is not built: nothing exports a
 * caption onto a video today.
 */
export function RoundBadge({ board, round, shots }: { board: string; round: BoardRound; shots?: number }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const copy = useCopyWhatChanged(board, round, shots);
  return (
    <>
      <button ref={anchor} type="button" className="v12-rd-badge" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="v12-round-badge">{roundBadge(round)}</button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={`What changed · Round ${round.n}`} width={360} testId="v12-round-changed">
        <div className="v12-rd-pop">
          <div className="v12-rd-pop-head"><strong>What changed · Round {round.n}</strong><span>{roundDate(round.at)}</span></div>
          {round.changes.map((c) => (
            <div key={c.shot} className="v12-rd-change" data-testid="v12-round-change"><span className="v12-rd-dot" aria-hidden="true" /><span>Shot {c.shot}: {c.text}</span></div>
          ))}
          <button type="button" className="v12-rd-btn" onClick={() => void copy()} data-testid="v12-round-copy">Copy for WhatsApp / email</button>
        </div>
      </Popover>
    </>
  );
}
