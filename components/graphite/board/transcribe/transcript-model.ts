import type { TranscriptResult, TranscriptWord } from "@/lib/workbench/transcription-request";

/*
 * A transcript as the board keeps and shows it (gap screens, Transcribe). Pure: lines with a time and a speaker, built from the
 * route's timed words; a person edits the words of any line. Saved in this browser under the request's own slot, so a transcript that
 * was paid for is still there after a reload and nothing is bought twice by accident.
 */

export type TranscriptLine = { speaker: number | null; at: number; text: string };
export type SavedTranscript = { name: string; seconds: number; language: string | null; lines: TranscriptLine[]; edited: boolean; savedAt: number };

/** Lines by speaker, from the timed words: a new line each time the speaker changes. */
export function linesFrom(words: readonly TranscriptWord[], fallbackText: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const word of words) {
    const speaker = word.speaker ?? null, last = lines.at(-1);
    if (last && last.speaker === speaker) last.text += ` ${word.text}`;
    else lines.push({ speaker, at: word.start, text: word.text });
  }
  if (!lines.length && fallbackText.trim()) lines.push({ speaker: null, at: 0, text: fallbackText.trim() });
  return lines;
}

export function savedFrom(name: string, result: TranscriptResult): SavedTranscript {
  return { name, seconds: result.seconds, language: result.language, lines: linesFrom(result.words, result.text), edited: false, savedAt: Date.now() };
}

/** "0:12.5": minutes, seconds and tenths, as a transcript reads. */
export function stamp(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const speakerName = (line: TranscriptLine) => (line.speaker == null ? null : `Speaker ${line.speaker + 1}`);

/** The plain script: each line on its own, with who said it where the speakers were told apart. */
export function scriptFrom(lines: readonly TranscriptLine[]): string {
  return lines.filter((l) => l.text.trim()).map((l) => `${speakerName(l) ? `${speakerName(l)!.toUpperCase()}\n` : ""}${l.text.trim()}`).join("\n\n");
}

function srtTime(s: number): string {
  const ms = Math.round(Math.max(0, s) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** Subtitles for download, from the lines as they stand (edits included): each shows until the next begins, or three seconds. */
export function srtFrom(lines: readonly TranscriptLine[], totalSeconds: number): string {
  const kept = lines.filter((l) => l.text.trim());
  return kept.map((l, i) => {
    const next = kept[i + 1]?.at ?? Math.min(totalSeconds || l.at + 3, l.at + 6);
    return `${i + 1}\n${srtTime(l.at)} --> ${srtTime(Math.max(next, l.at + 0.5))}\n${l.text.trim()}\n`;
  }).join("\n");
}

/* ── The browser's copy ─────────────────────────────────────────────────────────────── */

const PREFIX = "particl:transcript:v1:";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const cache = new Map<string, { raw: string; value: SavedTranscript | null }>();

export function readSaved(slot: string): SavedTranscript | null {
  let raw = "";
  try { raw = window.localStorage.getItem(PREFIX + slot) ?? ""; } catch { return null; }
  const hit = cache.get(slot);
  if (hit && hit.raw === raw) return hit.value;
  let value: SavedTranscript | null = null;
  try {
    const parsed = raw ? JSON.parse(raw) as SavedTranscript : null;
    if (parsed && Array.isArray(parsed.lines) && typeof parsed.seconds === "number") value = parsed;
  } catch { value = null; }
  cache.set(slot, { raw, value });
  return value;
}
export function writeSaved(slot: string, value: SavedTranscript): void {
  try { window.localStorage.setItem(PREFIX + slot, JSON.stringify(value)); } catch { /* storage off: the transcript stays on screen for this visit only */ }
  emit();
}
export function subscribeSaved(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
