/**
 * What a person may read of a direct engine's working record in a take's params (lip-sync's `lipsync`, FLUX.2's `bfl`, Sarvam's `sarvam`).
 *
 * Those records keep the workflow's own state: the vendor's job and asset ids, the polling address, lease and claim times, the consent ids, the SHA-256 of
 * the face still, what the vendor charged and what it said it would. None of it is for a browser, a token or an export: ids a vendor holds copies under, links,
 * the figures behind the margin. The row keeps all of it for the workflow; every read (lib/jobs.ts rowToGeneration, lib/workspaceExport.ts) goes through
 * this, which keeps only what describes the take: its state, its model and the settings the person chose.
 *
 * Pure and client-safe (no imports).
 */
const KEEP: Record<string, { key: string; fields: string[] }> = {
  lipsync: { key: "lipsync", fields: ["status", "model", "syncMode", "seconds"] },
  bfl_image: { key: "bfl", fields: ["status", "tool", "model", "width", "height", "outputMegapixels"] },
  sarvam_speech: { key: "sarvam", fields: ["tool", "model", "language", "chars"] },
};

export function publicDirectParams<T extends Record<string, unknown>>(params: T): T {
  const rule = typeof params.task === "string" ? KEEP[params.task] : undefined;
  if (!rule) return params;
  const record = params[rule.key];
  const next: Record<string, unknown> = { ...params };
  if (record && typeof record === "object" && !Array.isArray(record)) {
    next[rule.key] = Object.fromEntries(rule.fields.filter((f) => f in (record as Record<string, unknown>)).map((f) => [f, (record as Record<string, unknown>)[f]]));
  } else delete next[rule.key];
  return next as T;
}
