import { z } from "zod";
import { ASPECTS, CAPTION_STYLES, FPS_CHOICES, REFRAME_MODES } from "../../remotion/src/lib/types";
import { DEFAULT_LIMITS } from "../../remotion/src/lib/limits";
import type { ExportRequest } from "./contract";

/**
 * The assembly tool's input: one timeline of shots, voice lines, music, titles and words, cut into one MP4 on the export worker.
 *
 * It is the `final` template (remotion/src/lib/timeline.ts) asked for by what a film is made of rather than by template props:
 * an ordered list of shots, spoken lines placed on the finished film's clock, music, a title and an end card, and the words of
 * the lines as captions and subtitles. Every file is named by handle (`{ take }` or `{ upload }`), never by URL or path; the
 * export route resolves each handle inside the caller's own workspace and the worker gets the files, not addresses
 * (lib/exports/inputs.ts). The result is an ordinary export job (lib/exports/jobs.ts): the same queue, the same fair-share
 * limits, the same gate, free, and idempotent per `requestId`.
 *
 * The paid steps a film depends on (the shots, a voice, a piece of music) are made first on their own tools, at their own
 * prices and approvals; this tool only cuts what already exists. Pure: no database, no worker.
 */

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const id = z.string().regex(ID);
/** Exactly one of take or upload. */
const oneMedia = (value: { take?: string; upload?: string }) => (value.take === undefined) !== (value.upload === undefined);
const WHICH = "name exactly one of take or upload";
const seconds = z.number().finite().min(0).max(24 * 3600);

export const ASSEMBLE_LIMITS = { shots: DEFAULT_LIMITS.maxClips, voice: 24, text: DEFAULT_LIMITS.maxTextChars } as const;

const shot = z
  .object({
    take: id.optional(),
    upload: id.optional(),
    /** Part of the shot to use; default the whole of it. */
    trim: z.object({ startSeconds: seconds, endSeconds: seconds }).strict().optional(),
    /** Use the shot's own sound. Default false: a shot is silent unless asked. */
    hasAudio: z.boolean().optional(),
    /** How the shot fills the frame when its shape differs from the film's. */
    reframe: z.object({ mode: z.enum(REFRAME_MODES).optional(), focusX: z.number().finite().min(0).max(1).optional(), focusY: z.number().finite().min(0).max(1).optional() }).strict().optional(),
  })
  .strict()
  .refine(oneMedia, WHICH);

const voiceLine = z
  .object({
    take: id.optional(),
    upload: id.optional(),
    /** Where the line starts on the finished film's clock. */
    startSeconds: seconds,
    volume: z.number().finite().min(0).max(1).optional(),
    /** What the line says: shown as a caption while it plays and written to the subtitle files. */
    text: z.string().max(ASSEMBLE_LIMITS.text).optional(),
  })
  .strict()
  .refine(oneMedia, WHICH);

const music = z
  .object({ take: id.optional(), upload: id.optional(), volume: z.number().finite().min(0).max(1).optional() })
  .strict()
  .refine(oneMedia, WHICH);

/** A title or end card: the template's own fields, checked by the template's rules when the export is admitted. */
const card = z.record(z.string(), z.unknown());

export const assembleSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    timeline: z
      .object({
        aspect: z.enum(ASPECTS),
        fps: z.number().refine((n) => (FPS_CHOICES as readonly number[]).includes(n), "fps must be 24, 25, 30 or 60").optional(),
        title: card.optional(),
        shots: z.array(shot).min(1).max(ASSEMBLE_LIMITS.shots),
        voice: z.array(voiceLine).max(ASSEMBLE_LIMITS.voice).optional(),
        music: music.optional(),
        /** Burn the voice lines' words into the picture in this style; null or absent: no burned-in words (subtitle files still can be asked for). */
        captions: z.enum(CAPTION_STYLES).nullable().optional(),
        end: card.optional(),
        /** The share of its level the music and the shots' sound keep while a voice line plays: 1 = no ducking. */
        duck: z.number().finite().min(0).max(1).optional(),
      })
      .strict(),
    /** The finished files, as for any export: `{ format, subtitles: ["srt","vtt"], conform }`. */
    output: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type AssembleRequest = z.infer<typeof assembleSchema>;

/** The `final` export this timeline is. Handles stay handles; the export route resolves them. */
export function assembleToExport(input: AssembleRequest): ExportRequest {
  const t = input.timeline;
  const handle = (value: { take?: string; upload?: string }) => (value.take !== undefined ? { take: value.take } : { upload: value.upload });
  return {
    requestId: input.requestId,
    composition: "final",
    props: {
      aspect: t.aspect,
      ...(t.fps !== undefined ? { fps: t.fps } : {}),
      ...(t.title ? { title: t.title } : {}),
      clips: t.shots.map((s) => ({
        source: { ...handle(s), hasAudio: s.hasAudio === true },
        ...(s.trim ? { trim: s.trim } : {}),
        ...(s.reframe ? { reframe: s.reframe } : {}),
      })),
      captionStyle: t.captions ?? null,
      ...(t.end ? { end: t.end } : {}),
      ...(t.music ? { music: { ...handle(t.music), ...(t.music.volume !== undefined ? { volume: t.music.volume } : {}) } } : {}),
      ...(t.voice?.length ? { voiceover: t.voice.map((v) => ({ ...handle(v), startSeconds: v.startSeconds, ...(v.volume !== undefined ? { volume: v.volume } : {}), ...(v.text ? { text: v.text } : {}) })) } : {}),
      ...(t.duck !== undefined ? { duck: t.duck } : {}),
    },
    ...(input.output ? { output: input.output } : {}),
  };
}
