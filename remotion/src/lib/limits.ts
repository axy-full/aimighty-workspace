/** Bounds on what one export may ask for. The worker can tighten them with its environment; it never loosens them. */
export type ExportLimits = {
  /** Longest finished video. */
  maxSeconds: number;
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

/**
 * The longest ProRes export, in FRAMES (not seconds, so the size cannot be got round with a higher frame rate): 60 s at 30 fps is
 * 1800 frames, and so is 30 s at 60 fps. A ProRes frame is about 0.5 to 0.8 MB at 1080p, so this keeps a file to about 1.4 GB, which
 * the worker's session disk holds beside a maximum upload. A constant, not a setting: nothing can raise it.
 */
export const PRORES_MAX_FRAMES = 60 * 30;
