import { costUsd, estimateTokens, getModel } from "./models";
import { estimateVideo, type RateTable } from "./rateTable";
import { videoReferenceSeconds } from "./referenceDuration";

/** Use the same reference duration rules as submission, over customer-visible rates. */
export function estimateComposerVideo(
  rates: RateTable,
  modelId: string,
  resolution: string,
  ratio: string,
  seconds: number,
  audio: boolean,
  references: { kind: string; durationS: number | null }[],
): number | null {
  const inputSeconds = videoReferenceSeconds(references);
  if (inputSeconds == null) return null;
  return estimateVideo(
    rates,
    modelId,
    resolution,
    seconds,
    estimateTokens(resolution, ratio, seconds, inputSeconds),
    costUsd,
    {
      audio: audio && getModel(modelId).supportsAudio,
      hasVideoInput: references.some((reference) => reference.kind === "video"),
    },
  );
}
