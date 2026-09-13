/** Generated clips retain their output duration in the saved generation parameters. */
export function generatedReferenceSeconds(params: unknown): number | null {
  let value: unknown = params;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const duration = value && typeof value === 'object' ? Number((value as { duration?: unknown }).duration) : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}
export function videoReferenceSeconds(references: { kind: string; durationS: number | null }[]): number | null {
  let total = 0;
  for (const reference of references) {
    if (reference.kind !== 'video') continue;
    if (reference.durationS == null || !Number.isFinite(reference.durationS) || reference.durationS <= 0) return null;
    total += reference.durationS;
  }
  return total;
}
