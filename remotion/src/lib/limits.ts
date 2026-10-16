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

/**
 * The longest DNxHR export, in FRAMES for the same reason: 40 s at 30 fps is 1200 frames, and so is 20 s at 60 fps. A DNxHR HQ or HQX frame is a fixed size at a size of picture
 * (measured 16 Oct 2026: 0.92 MB at 1920x1080, the same for HQ and HQX, plus 0.2 MB a second of PCM sound), and the file is made from a ProRes 422 intermediate (about 0.54 MB a frame
 * measured, 0.7 held) that exists beside it while ffmpeg writes it. At the cap, the session disk (3072 MiB) holds a maximum upload (600 MiB) + the intermediate + the file with
 * about 600 MiB to spare; 1500 frames would leave 140. A constant, not a setting: nothing can raise it.
 */
export const DNXHR_MAX_FRAMES = 40 * 30;
/** The figures behind DNXHR_MAX_FRAMES, in bytes a frame at 1080p, held by a test so the cap cannot drift from them. */
export const DNXHR_FRAME_BYTES = { file: 0.93e6, intermediate: 0.7e6 } as const;

/** The frame limit of a format, or null for H.264 (held to the export's seconds only). */
export const maxFramesOf = (format: "h264" | "prores-422" | "prores-422-hq" | "dnxhr-hq" | "dnxhr-hqx"): number | null =>
  format === "h264" ? null : format.startsWith("dnxhr") ? DNXHR_MAX_FRAMES : PRORES_MAX_FRAMES;
