/**
 * Runway (brief 2.2): the workspace's balance and its burn rate, read as
 * days. The pace is what the workspace actually spent over the last seven
 * calendar days — quiet days count as zero, which is the honest divisor —
 * and the answer is how many days the balance lasts at that pace. Pure.
 */
export type DaySpend = { day: number; credits: number };
export type Runway = { perDay: number | null; days: number | null; windowDays: number; spent: number; known: boolean };

export const RUNWAY_WINDOW_DAYS = 7;

export function runway(balance: number | null, byDay: DaySpend[], now: number, windowDays = RUNWAY_WINDOW_DAYS): Runway {
  const since = now - windowDays * 86_400_000;
  const spent = byDay.filter((d) => d.day >= since && d.day <= now).reduce((a, d) => a + Math.max(0, d.credits || 0), 0);
  const known = balance != null && spent > 0;
  const perDay = known ? spent / windowDays : null;
  const days = perDay ? Math.floor(Math.max(0, balance!) / perDay) : null;
  return { perDay, days, windowDays, spent, known };
}

/** One line, or nothing while there is no pace to speak of. */
export function runwayLine(r: Runway, credits: (n: number) => string): string {
  if (!r.known || r.perDay == null || r.days == null) return "";
  const pace = `${credits(Math.round(r.perDay))} a day over the last ${r.windowDays} days`;
  if (r.days === 0) return `At ${pace}, the balance does not last the day.`;
  if (r.days > 365) return `At ${pace}, more than a year of runway.`;
  return `At ${pace}, about ${r.days} day${r.days === 1 ? "" : "s"} of runway.`;
}
