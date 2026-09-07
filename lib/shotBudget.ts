import { estimateCostUsd, DEFAULT_MODEL_ID } from "./models";

/**
 * What a shot is expected to cost before it has a take (brief 2.6).
 *
 * A shot written in Atomik arrives on the wall with its planned length and
 * nothing rendered: this is what one take of it would cost on the default
 * engine, so the shot list's estimate and the wall's agree. Seedance bills
 * five seconds at least, which is why a three-second plan costs the same as
 * a five. Pure.
 */
export const MIN_BILLED_SECONDS = 5;

export function plannedTakeUsd(planned: number | null | undefined, modelId: string = DEFAULT_MODEL_ID): number {
  const seconds = Math.max(MIN_BILLED_SECONDS, Number(planned) || MIN_BILLED_SECONDS);
  return estimateCostUsd(modelId, "1080p", "16:9", seconds)?.net ?? 0;
}

/** What the wall says under a shot nobody has rendered yet. */
export function plannedLine(planned: number | null | undefined, price: (usd: number) => string): string {
  const secs = Number(planned) || 0;
  const cost = price(plannedTakeUsd(planned));
  return secs ? `no takes yet · ${secs}s planned · ${cost} a take` : `no takes yet · ${cost} a take`;
}
