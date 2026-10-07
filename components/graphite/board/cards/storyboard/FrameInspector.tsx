"use client";
import { boardShots, shotPrompt } from "@/lib/production/boards";
import type { CardProps } from "../types";
import type { FrameData } from "../plan/derive";

/** A storyboard frame in the Inspector (the nearest frame to README § 3.1 k): its name and line, and the words it is drawn from. */
export function FrameInspector({ data, ctx }: CardProps<FrameData>) {
  const frame = ctx.project.production?.boards?.frames[data.shotId];
  const shot = boardShots(ctx.project.production?.beats).find((s) => s.id === data.shotId);
  const prompt = frame?.prompt.trim() || (shot ? shotPrompt(shot) : "");
  return (
    <div className="gx-insp-take" data-testid="insp-frame">
      <div className="gx-insp-title">{data.name}</div>
      <div className="gx-insp-meta">{data.line}</div>
      {prompt ? <div><div className="gx-insp-eyebrow">Drawn from</div><p className="gx-insp-prompt">{prompt}</p></div> : null}
    </div>
  );
}
