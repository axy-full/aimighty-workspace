"use client";
import { useState } from "react";
import { Dialog } from "@/components/v12/ui/Dialog";
import { defineCard, type CardProps, type CardSet } from "@/components/graphite/board/cards/types";
import { roundDate, ROUND_LINE } from "@/lib/v12/rounds";
import { deriveRounds, type CompareShot, type RoundCardData } from "./round-derive";
import { useCopyWhatChanged } from "./RoundBadge";
import "./rounds.css";

/*
 * The client round on the board (redesign P2-c; prototype L571, L577, L578; docs/redesign/inventory.md § 6.7). Client approval
 * happens outside the app, so there is no sign-in for a client and no Send on a card: the board holds the round and its words.
 *  - Storyboard: "Round 2 · what changed", the list, and the way to copy it (WhatsApp, email).
 *  - Cut: "Compare R1 / R2", the two takes of a changed shot side by side; and the copy.
 *  - Deliver: the copy, for the message that goes with the delivery.
 * The MP4 with "Board · R2 · date" burned in is not built: no export here can put a caption onto a video.
 */
const WIDTH = 280;

function Side({ label, side, empty }: { label: string; side: CompareShot["r1"]; empty: string }) {
  return (
    <div className="v12-rd-side" data-testid="v12-compare-side">
      <div className="v12-rd-media">
        {side ? (side.media === "video"
          ? <video src={side.url} controls playsInline preload="metadata" />
          // eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, already sized
          : <img src={side.url} alt="" />) : <span className="v12-rd-empty">{empty}</span>}
      </div>
      <div className="v12-rd-side-meta"><strong>{label}</strong><span>{side ? `${side.label} · ${side.engine}` : ""}</span></div>
    </div>
  );
}

function Compare({ open, onClose, data }: { open: boolean; onClose: () => void; data: RoundCardData }) {
  const [pick, setPick] = useState(0);
  const one = data.compare[Math.min(pick, data.compare.length - 1)];
  return (
    <Dialog open={open} onClose={onClose} label={`Compare R1 and R${data.round.n}`} title={<>Compare <span className="v12-rd-sub">Side by side · the same shot, both rounds</span></>} width={920} closeTip="Close · Esc">
      <div className="v12-rd-compare" data-testid="v12-compare">
        {data.compare.length > 1 ? (
          <div className="v12-rd-picks" role="group" aria-label="Shot">
            {data.compare.map((c, i) => <button key={c.shot} type="button" className="v12-rd-pick" aria-pressed={i === pick} onClick={() => setPick(i)} data-testid="v12-compare-shot">Shot {c.shot}</button>)}
          </div>
        ) : null}
        {one ? (
          <div className="v12-rd-sides">
            <Side label="R1" side={one.r1} empty="The take before the round is not kept for this shot." />
            <Side label={`R${data.round.n} · ${roundDate(data.round.at)}${one.r2 ? "" : " · not ready yet"}`} side={one.r2} empty="Round 2 for this shot is still being made." />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export function RoundCard({ data }: CardProps<RoundCardData>) {
  const [compare, setCompare] = useState(false);
  const copy = useCopyWhatChanged(data.board, data.round, data.shots);
  const n = data.round.changes.length;
  const rest = Math.max(0, data.shots - n);
  const btn = (label: string, run: () => void, id: string, hot = false) => (
    <button type="button" className="v12-rd-btn nodrag nopan" data-hot={hot || undefined} onClick={(e) => { e.stopPropagation(); run(); }} onDoubleClick={(e) => e.stopPropagation()} data-testid={id}>{label}</button>
  );
  return (
    <article className="v12-rd-card" data-variant={data.variant} aria-label={`Round ${data.round.n}`} data-testid="v12-round-card">
      <div className="v12-rd-head">
        <span className="v12-rd-title">{data.variant === "changed" ? `Round ${data.round.n} · what changed` : data.variant === "cut" ? "Compare R1 / R2" : `Share round ${data.round.n}`}</span>
        <span className="v12-rd-state"><span className="v12-rd-dot" aria-hidden="true" />{data.variant === "cut" ? "Side by side · both rounds" : "Client round"}</span>
      </div>
      {data.variant === "changed" ? (
        <>
          <div className="v12-rd-list">
            {data.round.changes.map((c) => <div key={c.shot} className="v12-rd-row" data-testid="v12-round-line"><span className="v12-rd-num">{c.shot}</span><span>Shot {c.shot}: {c.text}</span></div>)}
          </div>
          <p className="v12-rd-body">{n} {n === 1 ? "shot" : "shots"} redrawn in Round {data.round.n}{rest ? `; the other ${rest} ${rest === 1 ? "is" : "are"} untouched` : ""}. R1 is kept.</p>
        </>
      ) : <p className="v12-rd-body">{data.variant === "cut" ? `${n} ${n === 1 ? "shot" : "shots"} to compare: ${data.round.changes.map((c) => `Shot ${c.shot}`).join(", ")}.` : `The words for the client: what changed in round ${data.round.n}, ready to paste.`}</p>}
      <div className="v12-rd-acts">
        {data.variant === "cut" ? btn("Compare R1 / R2", () => setCompare(true), "v12-round-compare", true) : null}
        {data.variant === "changed" ? btn("Compare R1 / R2", () => setCompare(true), "v12-round-compare") : null}
        {btn("Copy what changed", () => void copy(), "v12-round-copy-card", data.variant !== "cut")}
      </div>
      <Compare open={compare} onClose={() => setCompare(false)} data={data} />
    </article>
  );
}

const roundDef = defineCard<RoundCardData>({
  kind: "round",
  size: (data) => ({ w: WIDTH, h: data.variant === "changed" ? 150 + data.round.changes.length * 30 + 64 : 190 }),
  Card: RoundCard,
});

export const roundCards: CardSet = { id: "rounds", defs: [roundDef], derive: (src) => deriveRounds(src) };
export { ROUND_LINE };
