"use client";
import { SAMPLE_CLIP_CREDIT } from "@/lib/sampleClip";
import { useSampleClipTake } from "@/lib/useSampleClip";
import "./sample-clip-credit.css";

/**
 * The starter production's sample clip credit (owner, 15 Oct: "Big Buck Bunny © Blender Foundation, CC BY 3.0", linked to the licence and to the source): one short line under
 * the take, drawn only for a take that is the sample clip (lib/sampleClip.ts), nothing for any other. `take` is a Library id, a media URL or a generation id.
 */
export function SampleClipCredit({ take, over = false, className = "" }: { take: string | null | undefined; /** Over the bottom of the picture it stands on (a card, a tile), else a line of its own. */ over?: boolean; className?: string }) {
  const on = useSampleClipTake(take);
  return on ? <SampleClipCreditLine over={over} className={className} /> : null;
}

/** The line itself, for a surface that already knows the take is the clip (the review link's own data says so). */
export function SampleClipCreditLine({ over = false, className = "" }: { over?: boolean; className?: string }) {
  return (
    <p className={`sample-credit${over ? " sample-credit--over" : ""} ${className}`.trim()} data-testid="sample-credit" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <a href={SAMPLE_CLIP_CREDIT.sourceUrl} target="_blank" rel="noopener noreferrer">{SAMPLE_CLIP_CREDIT.title}</a> © Blender Foundation, <a href={SAMPLE_CLIP_CREDIT.licenceUrl} target="_blank" rel="noopener noreferrer">{SAMPLE_CLIP_CREDIT.licence}</a>
    </p>
  );
}
