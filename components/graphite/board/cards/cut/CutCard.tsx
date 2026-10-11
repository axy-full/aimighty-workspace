"use client";
import type { ButtonHTMLAttributes } from "react";
import LazyMedia from "@/components/LazyMedia";
import { useSession } from "@/lib/session";
import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardCtx, type CardProps } from "../types";
import { secondsWords, type CutCardData, type CutClip } from "./cut-model";
import { CutBody } from "../../inspector/CutBody";
import { openEditSound } from "./edit-sound";
import "./cut.css";

/*
 * Frame i's Cut card (README § 3.1): the cut's clips in order as thumbnails, a mini timeline in seconds, "The cut"
 * and its list, and Open Edit & Sound, which opens the existing editor over the board. It reads the edit's own
 * sequence; shots with no clip in it are said to be waiting, in the Shots region's words.
 */

function Btn({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`gx-cut-btn nodrag nopan${className ? ` ${className}` : ""}`} onDoubleClick={(e) => e.stopPropagation()} />;
}

export const CUT_SIZE = { w: 486, h: 330 } as const;

function Thumb({ clip }: { clip: CutClip }) {
  return (
    <figure className="gx-cut-thumb" data-approved={clip.approved || undefined} data-testid="cut-clip" style={{ flexGrow: Math.max(1, clip.seconds) }}>
      <span className="gx-cut-pic">
        {clip.still ? <LazyMedia url={clip.still.url} kind={clip.still.kind} alt="" name={clip.label} preview={false} /> : <span className="gx-cut-face" aria-hidden="true" />}
      </span>
      <figcaption className="gx-cut-tag">{clip.label}</figcaption>
    </figure>
  );
}

export function CutCard({ data, ctx }: CardProps<CutCardData>) {
  const { signedIn } = useSession();
  const { cut } = data;
  const act = signedIn && !ctx.offline;
  const list = cut.clips.map((c) => c.short).join(" · ");
  return (
    <article className="gx-cut" aria-label="The cut" data-testid="cut-card" data-complete={cut.complete || undefined}>
      {cut.clips.length ? (
        <>
          <div className="gx-cut-strip" role="list" aria-label="Clips in the cut">{cut.clips.map((c) => <Thumb key={c.id} clip={c} />)}</div>
          <div className="gx-cut-line" aria-hidden="true" data-testid="cut-timeline">
            {cut.clips.map((c) => <span key={c.id} className="gx-cut-seg" data-approved={c.approved || undefined} style={{ flexGrow: Math.max(1, c.seconds) }}>{secondsWords(c.seconds)}</span>)}
          </div>
        </>
      ) : <div className="gx-cut-empty" data-testid="cut-empty">No takes in the cut yet. Approve a take, then add it in Edit &amp; Sound.</div>}
      <div className="gx-cut-foot">
        <div className="gx-cut-words">
          <div className="gx-cut-title">The cut</div>
          <div className="gx-cut-list" data-testid="cut-list">{list || "Nothing yet"}</div>
          {cut.waiting.length ? (
            <div className="gx-cut-wait" data-testid="cut-waiting">{cut.waiting.map((w) => `Shot ${w.shot} ${w.word}`).join(" · ")}</div>
          ) : null}
        </div>
        {act ? <Btn onClick={(e) => { e.stopPropagation(); openEditSound(); }} data-testid="cut-open-edit">Open Edit &amp; Sound</Btn> : null}
      </div>
    </article>
  );
}

export const cutDef = defineCard<CutCardData>({
  kind: "cut",
  size: () => CUT_SIZE,
  Card: CutCard,
  Inspector: CutBody,
  onOpen: (card: BoardCard<CutCardData>, ctx: BoardCtx) => ctx.openInspector(card.id),
});
