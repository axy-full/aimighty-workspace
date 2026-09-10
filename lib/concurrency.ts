/**
 * How many jobs an engine was running at once, at its worst (SOW §7).
 *
 * "That reading is what justifies a provider limit increase later, and it
 * can't be backfilled" — which turned out to be the one thing about it that
 * was wrong. Every meter row already carries when the job began
 * (`created_at`) and when it stopped (`updated_at`, moved by the completion
 * upsert, with `duration_ms` agreeing to the millisecond). The intervals are
 * the recording. The peak is a property of them.
 *
 * SO THIS IS DERIVED, NOT SAMPLED, and that is strictly better rather than
 * merely cheaper. A sampler sees the instants it happens to wake up on, and
 * a peak is precisely the thing most likely to fall between two of them — a
 * burst of six that lasts forty seconds is invisible to a per-minute sample
 * that lands on either side of it. A sweep over the intervals cannot miss
 * it, because the peak always occurs at an interval's start, and every start
 * is looked at.
 *
 * It also answers for history. The moment this shipped it could report the
 * worst minute the platform has ever had, not the worst since somebody
 * remembered to turn a cron on.
 *
 * Pure: no database, no clock. `now` is passed in, because a job still
 * running has no end yet and the answer depends on when you ask.
 */

export type Span = {
  /** The engine the job ran on — the unit a provider raises a limit for. */
  engine: string;
  startedAt: number;
  /** When it stopped, or null if it is still going. */
  endedAt: number | null;
};

export type Peak = {
  engine: string;
  /** The most that ran at once. */
  peak: number;
  /** When that started being true. */
  at: number;
  /** How many jobs the window saw at all, so a peak of 1 is readable as quiet rather than broken. */
  jobs: number;
};

/**
 * The most that overlapped, and when.
 *
 * A sweep line: +1 at every start, −1 at every end, walked in time order.
 * Ends are processed BEFORE starts at the same instant, so a job that
 * finishes exactly as another begins does not read as two at once — the
 * intervals are half-open, `[start, end)`, the same shape `cycleBounds` uses
 * and for the same reason.
 *
 * A job with no end is open: it counts from its start to `now` and never
 * closes. A job whose end is at or before its start ran for no measurable
 * time — the meter writes that when a render fails before it begins — and is
 * given the smallest possible non-zero life so it is counted once rather
 * than vanishing.
 */
export function peakOf(spans: readonly Span[], now: number): { peak: number; at: number } {
  if (!spans.length) return { peak: 0, at: 0 };
  const marks: { t: number; d: number }[] = [];
  for (const s of spans) {
    const start = s.startedAt;
    const end = s.endedAt == null ? now : Math.max(s.endedAt, start + 1);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    marks.push({ t: start, d: 1 });
    marks.push({ t: end, d: -1 });
  }
  /* Time first, then ends before starts: `d` ascending puts −1 before +1. */
  marks.sort((a, b) => (a.t - b.t) || (a.d - b.d));
  let running = 0, peak = 0, at = 0;
  for (const m of marks) {
    running += m.d;
    if (running > peak) { peak = running; at = m.t; }
  }
  return { peak, at };
}

/** The same, per engine, so the number can be taken to the provider it concerns. */
export function peakByEngine(spans: readonly Span[], now: number): Peak[] {
  const by = new Map<string, Span[]>();
  for (const s of spans) {
    const key = s.engine || "unknown";
    const list = by.get(key) ?? [];
    list.push(s);
    by.set(key, list);
  }
  return [...by.entries()]
    .map(([engine, list]) => {
      const { peak, at } = peakOf(list, now);
      return { engine, peak, at, jobs: list.length };
    })
    .sort((a, b) => b.peak - a.peak || b.jobs - a.jobs || a.engine.localeCompare(b.engine));
}

/**
 * The whole platform at once, whatever the engine.
 *
 * Not the sum of the per-engine peaks: those happen at different moments,
 * and adding them would report a number the platform never actually reached.
 */
export const peakOverall = (spans: readonly Span[], now: number): { peak: number; at: number } =>
  peakOf(spans, now);
