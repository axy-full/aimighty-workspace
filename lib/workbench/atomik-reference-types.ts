/** Persisted in the exact paid request, including during browser recovery. */
export type AtomikVideoFrame = {
  assetId: string;
  uploadId: string;
  timeSeconds: number;
  durationSeconds?: number;
};
export const ATOMIK_MAX_VISUALS = 6;
export const ATOMIK_IMAGE_EDGE = 512;
export const REFERENCE_AD_FRAMES = 12;
export const REFERENCE_AD_SECONDS = 60;
/** Conservative allowance for a bounded, low-detail still; actual usage is reconciled. */
export const ATOMIK_IMAGE_TOKENS = 8192;

export function atomikFrameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    throw new Error("Use a video up to one hour long for visual references.");
  return [
    ...new Set(
      [0.1, 0.5, 0.9].map(
        (fraction) => Math.round(duration * fraction * 1000) / 1000,
      ),
    ),
  ];
}

/** Sampling stays independent of the structured-analysis schema and model code. */
export function referenceAdFrameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration < 0.1 || duration > REFERENCE_AD_SECONDS)
    throw new Error(
      "Analyze a video between 0.1 and 60 seconds long. Keep the original and upload a shorter review clip if needed.",
    );
  return Array.from(
    { length: REFERENCE_AD_FRAMES },
    (_, index) => Math.round(((duration * (index + 0.5)) / REFERENCE_AD_FRAMES) * 1000000) / 1000000,
  );
}
