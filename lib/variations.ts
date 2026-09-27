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

/** A take's number in its batch (1–8), when it carries one. */
export const isVariation = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 8;

export type Sibling = { params?: unknown };
export type Strip<T> = { kind: "one"; take: T } | { kind: "batch"; batchId: string; takes: T[] };
/** Where a take says which batch it belongs to: `params` by default (a generation row). */
export type BatchOf<T> = (take: T) => { batchId?: unknown; variation?: unknown } | null | undefined;
const fromParams = <T,>(take: T) => (take as Sibling).params as { batchId?: unknown; variation?: unknown } | undefined;

/**
 * The takes of a shot with siblings gathered into one strip each, in first-seen
 * order, each strip in take order (take 1 first, whatever order the list is
 * in); a batch of one stays a single.
 */
export function groupSiblings<T>(takes: T[], batchOf: BatchOf<T> = fromParams): Strip<T>[] {
  const out: Strip<T>[] = [];
  const at = new Map<string, number>();
  for (const t of takes) {
    const id = batchOf(t)?.batchId;
    if (!isBatchId(id)) { out.push({ kind: "one", take: t }); continue; }
    const i = at.get(id);
    if (i == null) { at.set(id, out.length); out.push({ kind: "batch", batchId: id, takes: [t] }); }
    else (out[i] as { takes: T[] }).takes.push(t);
  }
  const order = (t: T) => { const v = batchOf(t)?.variation; return isVariation(v) ? v : Number.MAX_SAFE_INTEGER; };
  return out.map((s) => (s.kind === "batch" && s.takes.length === 1 ? { kind: "one", take: s.takes[0] }
    : s.kind === "batch" ? { ...s, takes: s.takes.map((t, i) => ({ t, i })).sort((a, b) => order(a.t) - order(b.t) || a.i - b.i).map(({ t }) => t) } : s));
}

/** "take 2": a take's label inside its strip. */
export const takeLabel = (variation: number): string => `take ${variation}`;
/** "take 1–4": what a strip holds, by the numbers of the takes in it. */
export function stripLabel(variations: readonly number[]): string {
  const known = variations.filter(isVariation);
  if (!known.length) return `${variations.length} takes`;
  const low = Math.min(...known), high = Math.max(...known);
  return low === high ? takeLabel(low) : `take ${low}–${high}`;
}
