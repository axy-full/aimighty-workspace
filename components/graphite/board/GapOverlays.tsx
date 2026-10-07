"use client";
import { BlockingOverlay } from "./blocking/BlockingOverlay";
import { TranscriptPanel } from "./transcribe/TranscriptPanel";
import type { BoardCtx } from "./cards/types";

/*
 * The panels and full-screen screens the gap cards open over the board (gap screens, lane 2): the transcript panel, and (3D blocking)
 * its overlay. Mounted once, by BoardView, whatever the board's kind.
 */
export function GapOverlays({ ctx }: { ctx: BoardCtx }) {
  return <><TranscriptPanel ctx={ctx} /><BlockingOverlay ctx={ctx} /></>;
}
