
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

/**
 * What the wall says under a shot nobody has rendered yet.
 *
 * The PRICE is handed in, already formatted. It used to be computed here from
 * `plannedTakeUsd` — a vendor estimate — which is why the wall, a client
 * component, dragged the whole rate table into its bundle for one sentence.
 */
export function plannedLine(planned: number | null | undefined, cost: string): string {
  const secs = Number(planned) || 0;
  return secs ? `no takes yet · ${secs}s planned · ${cost} a take` : `no takes yet · ${cost} a take`;
}
