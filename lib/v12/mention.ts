/**
 * "Click a Library tile to @mention it in the bar" (docs/redesign/inventory.md § 5.10).
 *
 * STUB, until the new bar lands (items C2, C3 and P2): the bar will listen here with `onMention` and put "@Name " into
 * its text. Until something listens, `requestMention` answers false and the tray falls back to what a click on a
 * Library tile does today (the shell selects the take, which opens it), so a click is never lost.
 */
export type Mention = { id: string; name: string };

const listeners = new Set<(mention: Mention) => void>();

/** A bar listens for mentions while it is mounted; the returned function stops it. */
export function onMention(listener: (mention: Mention) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hands a tile to the bar. False when no bar is listening (the caller falls back). */
export function requestMention(mention: Mention): boolean {
  if (!listeners.size) return false;
  for (const listener of listeners) listener(mention);
  return true;
}
