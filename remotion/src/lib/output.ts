import { H265_NAMES, SUBTITLE_FORMATS, VIDEO_FORMATS, type SubtitleFormat, type VideoFormat } from "./types";

/**
 * What a request may ask of the finished files, as the app reads it (the worker's own command checks the same words again
 * in `checkSpec`, remotion/node/export.ts). Pure: no file, no renderer. H.265 is refused whatever it is called.
 */
export const CONFORM_VALUES = ["auto", "off"] as const;
export type ConformValue = (typeof CONFORM_VALUES)[number];

export type OutputOptions = { format: VideoFormat; subtitles: SubtitleFormat[]; conform: ConformValue };
/** Conform is off by default (the worker's default too; the owner can turn it on). */
export const DEFAULT_OUTPUT: OutputOptions = Object.freeze({ format: "h264", subtitles: Object.freeze([]) as unknown as SubtitleFormat[], conform: "off" }) as OutputOptions;

export function parseOutputOptions(value: unknown): { ok: true; value: OutputOptions } | { ok: false; errors: string[] } {
  if (value === undefined || value === null) return { ok: true, value: { ...DEFAULT_OUTPUT, subtitles: [] } };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["output: must be an object"] };
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(rec)) if (!["format", "subtitles", "conform"].includes(key)) errors.push(`output.${key}: is not allowed`);
  let format: VideoFormat = "h264";
  if (rec.format !== undefined) {
    const asked = typeof rec.format === "string" ? rec.format.trim().toLowerCase() : "";
    if (H265_NAMES.includes(asked)) errors.push("output.format: H.265 is not available.");
    else if (!(VIDEO_FORMATS as readonly string[]).includes(asked)) errors.push(`output.format: must be one of ${VIDEO_FORMATS.join(", ")}`);
    else format = asked as VideoFormat;
  }
  let subtitles: SubtitleFormat[] = [];
  if (rec.subtitles !== undefined) {
    const asked = Array.isArray(rec.subtitles) && rec.subtitles.length <= 8 ? [...new Set(rec.subtitles.map((f) => (typeof f === "string" ? f.trim().toLowerCase() : "")))] : null;
    if (!asked || asked.length === 0 || asked.some((f) => !(SUBTITLE_FORMATS as readonly string[]).includes(f))) errors.push(`output.subtitles: must be a list of ${SUBTITLE_FORMATS.join(" and/or ")}`);
    else subtitles = asked as SubtitleFormat[];
  }
  let conform: ConformValue = "off";
  if (rec.conform !== undefined) {
    const asked = typeof rec.conform === "string" ? rec.conform.trim().toLowerCase() : "";
    if (!(CONFORM_VALUES as readonly string[]).includes(asked)) errors.push(`output.conform: must be ${CONFORM_VALUES.join(" or ")}`);
    else conform = asked as ConformValue;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { format, subtitles, conform } };
}
