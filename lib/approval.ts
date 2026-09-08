/**
 * The approval trail (brief 2.1): who picked a take, who approved it, when
 * — and what a shot with an approved take asks of the next render.
 *
 * A shot whose take is approved is locked. Locked does not mean closed: it
 * means the next take against that shot has to say why, so the record shows
 * a decision was revisited rather than quietly overwritten. Pure; the route
 * enforces it and the composer reads it.
 */
export type Trail = { pickedBy: string | null; pickedAt: number | null; approvedBy: string | null; approvedAt: number | null };

export const MIN_REASON = 3;
export const MAX_REASON = 300;

/** The reason as it will be stored, or null when there is nothing usable in it. */
export function cleanReason(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s.length >= MIN_REASON ? s.slice(0, MAX_REASON) : null;
}

/** A render against a locked shot needs a reason; everything else goes straight through. */
export function reasonNeeded(o: { hasApprovedTake: boolean; reason: unknown }): boolean {
  return o.hasApprovedTake && cleanReason(o.reason) === null;
}

/** What the person is asked, naming the take they are rendering past. */
export function lockAsk(version: number | null, by: string | null): { title: string; line: string } {
  const which = version ? `v${version}` : "a take";
  return {
    title: `${which} is approved. Why render another?`,
    line: `${by ? `${by} approved ${which}` : `${which} is approved`}. The reason is kept with the new take, so the shot's record says why it was revisited.`,
  };
}

/** The trail in one line, or nothing when a take has neither mark. */
export function trailLine(t: Trail, ago: (ms: number) => string): string {
  const parts: string[] = [];
  if (t.pickedBy) parts.push(`Picked by ${t.pickedBy}${t.pickedAt ? ` ${ago(t.pickedAt)}` : ""}`);
  if (t.approvedBy) parts.push(`approved by ${t.approvedBy}${t.approvedAt ? ` ${ago(t.approvedAt)}` : ""}`);
  return parts.join(" · ");
}
