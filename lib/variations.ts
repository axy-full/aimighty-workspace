/**
 * Batch variations (brief 1.6): N takes of one prompt in one press, filed
 * under the same shot as siblings, grouped on the wall so picking between
 * them is one screen. Pure; the browser reads it.
 */
export const COUNTS: Record<"video" | "image", number[]> = { video: [1, 2, 3, 4], image: [1, 2, 4, 8] };
export const maxCount = (kind: "video" | "image"): number => COUNTS[kind][COUNTS[kind].length - 1];
export const clampCount = (kind: "video" | "image", n: number): number => (COUNTS[kind].includes(n) ? n : 1);

/** One id per press; every sibling carries it. */
export const newBatchId = (): string => `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const isBatchId = (v: unknown): v is string => typeof v === "string" && /^b_[a-z0-9]{4,20}$/.test(v);

export type Sibling = { params?: unknown };
export type Strip<T> = { kind: "one"; take: T } | { kind: "batch"; batchId: string; takes: T[] };

/** The takes of a shot with siblings gathered into one strip each, in first-seen order; a batch of one stays a single. */
export function groupSiblings<T extends Sibling>(takes: T[]): Strip<T>[] {
  const out: Strip<T>[] = [];
  const at = new Map<string, number>();
  for (const t of takes) {
    const id = (t.params as { batchId?: unknown } | undefined)?.batchId;
    if (!isBatchId(id)) { out.push({ kind: "one", take: t }); continue; }
    const i = at.get(id);
    if (i == null) { at.set(id, out.length); out.push({ kind: "batch", batchId: id, takes: [t] }); }
    else (out[i] as { takes: T[] }).takes.push(t);
  }
  return out.map((s) => (s.kind === "batch" && s.takes.length === 1 ? { kind: "one", take: s.takes[0] } : s));
}
