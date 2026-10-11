/*
 * "Change with words" pressed on a take's card opens the Inspector on that take already in Change (the same panel the Inspector's own
 * button opens: Seedance Edit on a clip, Make with the take as its reference on a still). The card leaves the take's generation id here
 * and the Inspector's take body takes it once, whether it mounts after the press or is already open.
 */
let wanted: string | null = null;
const listeners = new Set<() => void>();

export function askChange(genId: string) {
  wanted = genId;
  listeners.forEach((fn) => fn());
}
/** True once for the take that was asked about; the intent is then spent. */
export function takeChange(genId: string): boolean {
  if (wanted !== genId) return false;
  wanted = null;
  return true;
}
export function onChangeAsked(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
