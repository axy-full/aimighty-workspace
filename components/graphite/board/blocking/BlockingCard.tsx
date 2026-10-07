"use client";
import LazyMedia from "@/components/LazyMedia";
import { defineCard, type CardProps } from "../cards/types";
import { wellHeight } from "../cards/take/TakeCard";
import type { BlockingCardData } from "./blocking-model";
import { openBlocking } from "./blocking-store";
import "./blocking.css";

const WIDTH = 340, BODY = 148;

/**
 * The 3D blocking card (gap screens), in the Storyboard and Shots regions: the saved frame, or a quiet grid, the shot it is for,
 * whether it is saved to that shot, and the one way into the overlay. Opening and saving cost nothing.
 */
export function BlockingCard({ data, ctx, selected }: CardProps<BlockingCardData>) {
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? null;
  return (
    <article className="gx-bk" data-testid="blocking-card" data-saved={data.saved || undefined} aria-label={`3D blocking · Shot ${data.index}`}>
      <span className="gx-bk-well" style={{ height: wellHeight(WIDTH, ctx.project.aspect) }}>
        {data.frameUploadId ? <LazyMedia url={`/api/workbench/preview/upload/${encodeURIComponent(data.frameUploadId)}`} kind="image" alt="" preview={false} /> : <span className="gx-bk-grid" aria-hidden="true" />}
      </span>
      <span className="gx-bk-body">
        <span className="gx-bk-title">3D blocking</span>
        <span className="gx-bk-meta">Shot {data.index}{data.objects ? ` · ${data.objects}` : ""}</span>
        <span className="gx-bk-state" data-tone={data.saved ? "done" : "idle"}><i aria-hidden="true" />{data.saved ? `Saved to Shot ${data.index}${data.lens ? ` · ${data.lens}mm` : ""}` : "Not saved to a shot yet"}</span>
        <span className="gx-bk-acts">
          <button type="button" className="gx-bk-btn nodrag nopan" data-primary={(selected && !data.saved) || undefined} title={blocked ?? undefined}
            onClick={(e) => { e.stopPropagation(); openBlocking(data.nodeId); }} onDoubleClick={(e) => e.stopPropagation()} data-testid="blocking-open">
            {data.saved ? "Open" : "Open 3D blocking"}
          </button>
        </span>
      </span>
    </article>
  );
}

export const blockingDef = defineCard<BlockingCardData>({
  kind: "blocking",
  size: (_data, at) => ({ w: WIDTH, h: wellHeight(WIDTH, at.aspect) + BODY }),
  Card: BlockingCard,
  onOpen: (card) => openBlocking(card.data.nodeId),
});
