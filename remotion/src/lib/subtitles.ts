import { frameToMs } from "./captions";
import type { Cue, SubtitleFormat, Timeline } from "./types";

/**
 * Sidecar subtitles from the same cue data the captions are burned in from. Pure text: no renderer, no media file. The cues
 * are placed on the finished video's own clock (each clip's local cues plus where the clip starts), so a cutdown's, a final's or
 * a reframe's subtitles line up with its picture, and a caption that was cut away is not in the file.
 */

/** Every cue of the timeline, in the finished video's time, sorted, never overlapping (each clip's own are already normalised). */
export function subtitleCuesOf(timeline: Timeline): Cue[] {
  const out: Cue[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "clip") continue;
    const offset = frameToMs(item.from, timeline.fps);
    for (const cue of item.subtitleCues) {
      const startMs = Math.round(cue.startMs + offset);
      const endMs = Math.round(cue.endMs + offset);
      /* Rounding to whole milliseconds must never leave a cue with no length. */
      if (endMs > startMs) out.push({ startMs, endMs, text: cue.text });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Cue text is data, never syntax. `-->` is the timing separator of both formats, so it is written as the arrow `\u2192`; a `{\...}` override block
 * (ASS styling that some SubRip players honour) is dropped; and for SubRip, which has no way to escape markup, `<` and `>` are written
 * as the single angle quotes `\u2039` and `\u203A` so `<b>`, `<font ...>` and the like cannot style or break a cue (WebVTT writes them as entities instead).
 */
export function neutralise(text: string, format: SubtitleFormat): string {
  const plain = text.replace(/\{\\[^}]*\}/g, "").replace(/-->/g, "\u2192");
  return format === "srt" ? plain.replace(/</g, "\u2039").replace(/>/g, "\u203A") : plain;
}

/** Lines of at most `width` characters, broken at spaces (a single long word stays whole). */
export function wrapLines(text: string, width = 42): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function stamp(ms: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(milli).padStart(3, "0")}`;
}

/** WebVTT text must not carry markup characters: they are written as entities. */
const vttText = (line: string) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** SubRip: a counter, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the text, a blank line. */
export function toSrt(cues: Cue[]): string {
  return speakable(cues, "srt").map(({ cue, lines }, index) => `${index + 1}\n${stamp(cue.startMs, ",")} --> ${stamp(cue.endMs, ",")}\n${lines.join("\n")}\n`).join("\n");
}

/** The cues with text left in them after neutralising (a cue that was only styling is not written), each with its wrapped lines. */
function speakable(cues: Cue[], format: SubtitleFormat): { cue: Cue; lines: string[] }[] {
  return cues.map((cue) => ({ cue, lines: wrapLines(neutralise(cue.text, format)) })).filter(({ cue, lines }) => lines.length > 0 && cue.endMs > cue.startMs);
}

/** WebVTT: the `WEBVTT` header, then each cue as `HH:MM:SS.mmm --> HH:MM:SS.mmm`. */
export function toVtt(cues: Cue[]): string {
  const body = speakable(cues, "vtt").map(({ cue, lines }, index) => `${index + 1}\n${stamp(cue.startMs, ".")} --> ${stamp(cue.endMs, ".")}\n${lines.map(vttText).join("\n")}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

export const subtitleText = (format: SubtitleFormat, cues: Cue[]): string => (format === "srt" ? toSrt(cues) : toVtt(cues));
