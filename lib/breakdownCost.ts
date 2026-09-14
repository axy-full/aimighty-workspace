import { DEFAULT_MODEL_ID, estimateTokens, costUsd } from "./models";
import { estimateVideo, estimateImage, type RateTable } from "./rateTable";
import { ENGINE_MODEL } from "./shotBuilder";

/**
 * One take of a shot: Seedance bills 5s minimum, so shorter shots price at 5s.
 *
 * The rate table is an argument because this is a browser: it used to call
 * `shotCostUsd`, which reads the vendors' dollars, and importing that from a
 * client component is what put those dollars in the bundle. The table it is
 * handed is already in the unit this workspace pays in.
 */
export function takeCost(
  rates: RateTable,
  planned: number | null,
  engine?: string | null,
): number {
  const secs = Math.max(5, planned ?? 5);
  const model =
    engine === "kling" || engine === "nano-banana"
      ? ENGINE_MODEL[engine as "kling" | "nano-banana"]
      : DEFAULT_MODEL_ID;
  if (engine === "nano-banana")
    return estimateImage(rates, model, "2K", 0) ?? 0;
  return (
    estimateVideo(
      rates,
      model,
      "1080p",
      secs,
      estimateTokens("1080p", "16:9", secs, 0),
      costUsd,
      { audio: engine !== "kling" },
    ) ?? 0
  );
}
