/**
 * What a person may read of a direct engine's working record in a take's params (lip-sync's `lipsync`, FLUX.2's `bfl`, Veo's `veo`, Sarvam's `sarvam`, and the label check's `labelCheck` on any take).
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
  veo_video: { key: "veo", fields: ["status", "model", "durationSeconds", "resolution", "aspectRatio"] },
  sarvam_speech: { key: "sarvam", fields: ["tool", "model", "language", "chars"] },
};

/**
 * The label check's result (`params.labelCheck`, lib/visionLabel.ts) sits on ANY take, whatever made it, so it is read by its key, not by the take's task. A person may read
 * the verdict, the flag, the rules used, the required text, the text read with its words and boxes, and the difference; not which picture was read.
 */
const LABEL_CHECK_FIELDS = ["v", "verdict", "flagged", "mode", "rules", "expected", "detected", "distance", "ops", "words", "checkedAt", "truncated"];

export function publicDirectParams<T extends Record<string, unknown>>(params: T): T {
  let next: Record<string, unknown> = params;
  const rule = typeof params.task === "string" ? KEEP[params.task] : undefined;
  if (rule) {
    const record = params[rule.key];
    next = { ...params };
    if (record && typeof record === "object" && !Array.isArray(record)) {
      next[rule.key] = Object.fromEntries(rule.fields.filter((f) => f in (record as Record<string, unknown>)).map((f) => [f, (record as Record<string, unknown>)[f]]));
    } else delete next[rule.key];
  }
  if ("labelCheck" in next) {
    const check = next.labelCheck;
    next = { ...next };
    if (check && typeof check === "object" && !Array.isArray(check)) next.labelCheck = Object.fromEntries(LABEL_CHECK_FIELDS.filter((f) => f in (check as Record<string, unknown>)).map((f) => [f, (check as Record<string, unknown>)[f]]));
    else delete next.labelCheck;
  }
  return next as T;
}
