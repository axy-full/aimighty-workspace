/**
 * The phone Rig's "Apply vN" (components/rig/PhoneBoard): one new take per
 * shot that cites the asset. Pure, so what it prices and what it reports are
 * the same shots.
 */

type ShotWords = { title: string; description: string; setup?: Record<string, string | null> | null };

/** What a shot re-renders from: its words and its Setup. Empty when it has neither. */
export function rerenderPrompt(s: ShotWords): string {
  return [s.description || s.title, Object.values(s.setup ?? {}).filter(Boolean).join(" · ")].filter(Boolean).join(". ");
}

/** The shots that can actually re-render; only these are priced and sent. */
export function rerenderable<T extends ShotWords>(list: T[]): T[] {
  return list.filter((s) => rerenderPrompt(s));
}

/**
 * The one toast an Apply leaves (a new toast replaces the last one, so
 * everything has to be said at once): what started and what that costs,
 * what did not start and why, and what had nothing to render.
 */
export function applySummary(o: {
  asset: string; from: string; to: string;
  started: number; sent: number; cost: string;
  failure: string | null; skipped: number;
}): string {
  const takes = (n: number) => `${n} ${n === 1 ? "take" : "takes"}`;
  const parts = o.started
    ? [`${o.asset} → ${o.to} · ${o.started === o.sent ? takes(o.started) : `${o.started} of ${takes(o.sent)}`} rendering · ${o.cost}`]
    : [`Nothing started · ${o.asset} stays on ${o.from}`];
  if (o.failure) parts.push(o.failure);
  if (o.skipped) parts.push(`${o.skipped} ${o.skipped === 1 ? "shot has" : "shots have"} no words to render`);
  return parts.join(" · ");
}
