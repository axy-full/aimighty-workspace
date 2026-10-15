/** Bounds on what one export may ask for. The worker can tighten them with its environment; it never loosens them. */
export type ExportLimits = {
  /** Longest finished video. */
  maxSeconds: number;
  /** Longest finished ProRes video: a mezzanine is about 16 to 24 MB per second, so it is held to a shorter length. */
  maxProResSeconds: number;
  maxClips: number;
  maxCues: number;
  maxWordsPerCue: number;
  maxTextChars: number;
  /** Largest source file duration accepted. */
  maxSourceSeconds: number;
  maxStills: number;
  /** Smallest render scale (1 = 1920x1080). Below 1 is for previews and tests. */
  minScale: number;
};

export const DEFAULT_LIMITS: ExportLimits = {
  maxSeconds: 120,
  maxProResSeconds: 60,
  maxClips: 24,
  maxCues: 600,
  maxWordsPerCue: 24,
  maxTextChars: 160,
  maxSourceSeconds: 1800,
  maxStills: 6,
  minScale: 0.1,
};

/** Even pixel sizes only: H.264 4:2:0 needs them. */
export const evenPx = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
