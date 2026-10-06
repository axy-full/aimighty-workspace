"use client";
import { NodeCardShell, type NodeCardData } from "../cards/board/FallbackCards";
import { NODE_SIZE } from "../cards/set-board";
import { defineCard, type CardProps } from "../cards/types";
import { TRANSCRIBE_ROW, TranscribeAction } from "./TranscribeAction";

/** A reference card (kind `media`): the board's plain card, and — for a video or audio original — Transcribe under it. */
function MediaCard({ card, data, ctx }: CardProps<NodeCardData>) {
  const source = data.source ? (data.source.genId ? { genId: data.source.genId } : { uploadId: data.source.uploadId }) : null;
  return (
    <NodeCardShell data={data}>
      {source ? <TranscribeAction ctx={ctx} source={source} name={data.title || card.id} /> : null}
    </NodeCardShell>
  );
}

export const mediaDef = defineCard<NodeCardData>({
  kind: "media",
  size: (data) => ({ w: NODE_SIZE.media.w, h: NODE_SIZE.media.h + (data.source ? TRANSCRIBE_ROW : 0) }),
  Card: MediaCard,
});
