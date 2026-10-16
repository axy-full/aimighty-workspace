/**
 * What the Edit step keeps in a board's draft (v25 plan, PR 22 and 23-lite): how the cut is dressed, and what each language
 * says. Additive and optional draft JSON like `boardStages` and `boardLanguages` (lib/workbench/studio-schema.ts), saved and
 * merged with the rest of the draft. No table, no migration. Pure: no React, no server, no engine.
 *
 *  - `boardCut` is the cut beyond its shots: the music, the title and end cards, whether captions are burned in, and
 *    optionally a shot list of its own. With no `shots`, the cut is the edit's own sequence (`project.shots`, the clips Edit &
 *    Sound plays; components/graphite/board/cards/cut/cut-model.ts), each clip's take being the clip asset's `generationId`.
 *  - `boardVoice[language]` is what that language says: its voice lines (audio takes with the words and where each starts on
 *    the finished film's clock) and the shots that are replaced for it (a lip-synced take in place of the cut's take). Language
 *    codes are the Deliver stage's (`boardLanguages`): `en` is the film as made, `hi` Hindi, and so on.
 *
 * Everything names media by take id, never by URL; the export route resolves each id inside the caller's workspace
 * (lib/exports/inputs.ts). A voice line is an audio take made on its own tool, at its own price and approval; the Edit step only
 * places it. Whoever writes `boardVoice` (the Hindi tool, a person in the Edit step, an outside agent) writes exactly this shape.
 */

export const LANGUAGE_CODE = /^[a-z]{2,3}$/;
export const TAKE_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const CUT_DATA_LIMITS = { shots: 24, lines: 24, swaps: 24, languages: 12, text: 160, seconds: 24 * 3600 } as const;

export type CutShot = {
  /** The video take (a generation id). */
  take: string;
  /** Part of the take to use; default the whole of it. */
  trim?: { startSeconds: number; endSeconds: number };
  /** Use the take's own sound. Default false. */
  hasAudio?: boolean;
};
export type CutTitle = { title: string; subtitle?: string; durationSeconds?: number };
export type CutEnd = { headline: string; callToAction?: string; line?: string; durationSeconds?: number };
export type CutMusic = { take?: string; upload?: string; volume?: number };
export type CutCaptions = "bold" | "clean" | "karaoke" | null;

export type BoardCut = {
  /** The cut's own shot list. Absent: the edit's sequence. */
  shots?: CutShot[];
  music?: CutMusic;
  title?: CutTitle;
  end?: CutEnd;
  /** Burn the voice lines' words into the picture in this style; null or absent: none (subtitle files can still be asked for). */
  captions?: CutCaptions;
  /** The share of its level the music and the shots' sound keep while a voice line plays; 1 = no ducking. */
  duck?: number;
};

export type VoiceLine = {
  /** The audio take (a generation id of kind audio, with its length recorded). */
  take: string;
  /** Where the line starts on the finished film's clock, in seconds. Lines may not overlap. */
  startSeconds: number;
  /** What the line says: shown as a caption while it plays and written to the subtitle files. */
  text: string;
  volume?: number;
};
export type LanguageVoice = {
  lines: VoiceLine[];
  /** Shots replaced for this language: the cut's take id -> the take to use instead (a lip-synced version). */
  swap?: Record<string, string>;
};
export type BoardVoice = Record<string, LanguageVoice>;

/** The language the film is made in. */
export const BASE_LANGUAGE = "en";

/** A voice of one language, as the draft keeps it: only well-formed lines and swaps, in time order, within the limits. */
export function cleanLanguageVoice(value: unknown): LanguageVoice {
  const rec = (value && typeof value === "object" ? value : {}) as { lines?: unknown; swap?: unknown };
  const lines: VoiceLine[] = [];
  if (Array.isArray(rec.lines)) {
    for (const item of rec.lines) {
      const line = item as Partial<VoiceLine> | null;
      if (!line || typeof line.take !== "string" || !TAKE_ID.test(line.take)) continue;
      if (typeof line.startSeconds !== "number" || !Number.isFinite(line.startSeconds) || line.startSeconds < 0 || line.startSeconds > CUT_DATA_LIMITS.seconds) continue;
      const text = typeof line.text === "string" ? line.text.replace(/\s+/g, " ").trim().slice(0, CUT_DATA_LIMITS.text) : "";
      const volume = typeof line.volume === "number" && Number.isFinite(line.volume) ? Math.min(1, Math.max(0, line.volume)) : undefined;
      lines.push({ take: line.take, startSeconds: line.startSeconds, text, ...(volume !== undefined ? { volume } : {}) });
    }
  }
  lines.sort((a, b) => a.startSeconds - b.startSeconds);
  const swap: Record<string, string> = {};
  if (rec.swap && typeof rec.swap === "object" && !Array.isArray(rec.swap)) {
    for (const [from, to] of Object.entries(rec.swap as Record<string, unknown>)) {
      if (Object.keys(swap).length >= CUT_DATA_LIMITS.swaps) break;
      if (TAKE_ID.test(from) && typeof to === "string" && TAKE_ID.test(to)) swap[from] = to;
    }
  }
  return { lines: lines.slice(0, CUT_DATA_LIMITS.lines), ...(Object.keys(swap).length ? { swap } : {}) };
}

/** The voice of a language (a copy); nothing for a language that has none. */
export const voiceOf = (voice: BoardVoice | null | undefined, language: string): LanguageVoice =>
  Object.prototype.hasOwnProperty.call(voice ?? {}, language) ? cleanLanguageVoice(voice![language]) : { lines: [] };

/**
 * The board's voices after one language is written: the whole language is replaced (a Hindi version is made as one piece).
 * A language code the draft would refuse, or a thirteenth language, leaves the voices as they were; a language with no lines and
 * no swaps is removed.
 */
export function withLanguageVoice(voice: BoardVoice | null | undefined, language: string, value: unknown): BoardVoice {
  const current = voice ?? {};
  if (!LANGUAGE_CODE.test(language)) return current;
  const next = cleanLanguageVoice(value);
  const { [language]: _was, ...others } = current;
  if (!next.lines.length && !next.swap) return others;
  if (!(language in current) && Object.keys(current).length >= CUT_DATA_LIMITS.languages) return current;
  return { ...others, [language]: next };
}
