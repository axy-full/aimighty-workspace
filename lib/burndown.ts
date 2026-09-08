/**
 * The burn-down (brief 2.2): where a production's cap has gone, what it
 * will take to finish, and which shots are eating it.
 *
 * The projection is deliberately plain arithmetic on what the production
 * has actually done — takes per shot so far, spend per take so far — and it
 * says when it does not know. A producer can check it in their head, which
 * is the only way a number like this earns any trust. Pure.
 */
export type ShotSpend = { id: string; code: string; title?: string | null; takes: number; credits: number };

export type BurnDown = {
  /** What the production has spent, and its cap, in the workspace's unit. */
  spent: number;
  cap: number | null;
  left: number | null;
  pct: number | null;
  /** Shots the production has, and how many have a take. */
  shots: number;
  started: number;
  /** What one shot has cost on average so far, and how many takes it took. */
  perShot: number | null;
  takesPerShot: number | null;
  /** What finishing every shot at that rate would cost, and what that leaves. */
  projected: number | null;
  over: number | null;
  /** Enough of the production has run to say something. */
  known: boolean;
};

export function burnDown(o: { spentCredits: number; capCredits: number | null; shotCount: number; byShot: ShotSpend[] }): BurnDown {
  const started = o.byShot.filter((s) => s.takes > 0).length;
  const shots = Math.max(o.shotCount, started);
  const takes = o.byShot.reduce((a, s) => a + s.takes, 0);
  const known = started > 0 && o.spentCredits > 0;
  const perShot = known ? o.spentCredits / started : null;
  const takesPerShot = started ? takes / started : null;
  const projected = perShot == null ? null : Math.round(perShot * shots);
  const cap = o.capCredits;
  return {
    spent: o.spentCredits,
    cap,
    left: cap == null ? null : cap - o.spentCredits,
    pct: cap ? Math.min(999, Math.round((o.spentCredits / cap) * 100)) : null,
    shots, started, perShot, takesPerShot, projected,
    over: cap == null || projected == null ? null : projected - cap,
    known,
  };
}

/** The shots eating the most, biggest first, with each one's share of what has been spent. */
export function biggestBurners(byShot: ShotSpend[], spent: number, top = 5): (ShotSpend & { share: number })[] {
  return byShot
    .filter((s) => s.credits > 0)
    .sort((a, b) => b.credits - a.credits || b.takes - a.takes)
    .slice(0, top)
    .map((s) => ({ ...s, share: spent > 0 ? Math.round((s.credits / spent) * 100) : 0 }));
}

/** What the projection says, in a sentence, or nothing while it is guesswork. */
export function projectionLine(b: BurnDown, unit: (n: number) => string): string {
  if (!b.known || b.projected == null) return "";
  const rate = `${b.takesPerShot!.toFixed(1)} takes a shot so far`;
  const rest = b.shots - b.started;
  if (b.cap == null) return `${rest} shot${rest === 1 ? "" : "s"} to go — about ${unit(b.projected)} to finish at ${rate}.`;
  if (b.over != null && b.over > 0) return `At ${rate}, finishing costs about ${unit(b.projected)} — ${unit(b.over)} over the cap.`;
  return `At ${rate}, finishing costs about ${unit(b.projected)}, inside the cap by ${unit(Math.abs(b.over ?? 0))}.`;
}
