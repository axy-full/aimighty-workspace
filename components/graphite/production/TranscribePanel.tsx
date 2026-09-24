"use client";
import { useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";

type Word = { text: string; start: number; end: number; speaker?: number };
type Result = { text: string; language: string | null; seconds: number; words: Word[]; srt: string; credits: number };

/** Lines by speaker, from the timed words: "Speaker 1 · 0:04" then what they said. */
function bySpeaker(words: Word[]): { speaker: number | null; at: number; text: string }[] {
  const lines: { speaker: number | null; at: number; text: string }[] = [];
  for (const word of words) {
    const speaker = word.speaker ?? null, last = lines.at(-1);
    if (last && last.speaker === speaker) last.text += ` ${word.text}`;
    else lines.push({ speaker, at: word.start, text: word.text });
  }
  return lines;
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Grok transcription of a take (owner, 23 September: Grok APIs wherever
 * possible): priced by its length first, then the words — speakers told apart
 * — with subtitles to download. Billed as an xAI charge. Keyed by the take,
 * so choosing another take starts afresh.
 */
export function TranscribePanel({ scope, source, name, projectId }: { scope: string; source: { genId?: string; uploadId?: string }; name: string; projectId?: string }) {
  const [quote, setQuote] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const body = { ...(source.genId ? { sourceGenId: source.genId } : { sourceUploadId: source.uploadId }), ...(projectId ? { projectId } : {}), diarize: true };
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": scope };
  async function price() {
    setBusy("Pricing…"); setError("");
    try { setQuote((await studioRequest<{ estimatedCredits: number }>("/api/audio/transcribe", { method: "POST", headers, body: JSON.stringify({ ...body, quoteOnly: true }) })).estimatedCredits); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This take could not be priced."); }
    finally { setBusy(""); }
  }
  async function run() {
    if (quote == null) return;
    setBusy("Transcribing…"); setError("");
    try { setResult(await studioRequest<Result>("/api/audio/transcribe", { method: "POST", headers, body: JSON.stringify({ ...body, maxCredits: quote }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The transcription did not complete. A failed transcription is not billed."); }
    finally { setBusy(""); }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.srt], { type: "application/x-subrip" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/[^\w.-]+/g, "_") || "take"}.srt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="gx-gen-card gx-workflow" aria-label="Transcribe" data-testid="transcribe" data-section="transcribe">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Transcribe · Grok</span>
        <h2 className="gx-workflow-title">What is said in this take</h2>
        <p className="gx-hint">Every word, timed, with the speakers told apart — and subtitles to download. Priced by its length first.</p>
      </div>
      <div className="gx-gen-enhance">
        {quote == null ? (
          <button type="button" className="gx-primary" disabled={Boolean(busy)} onClick={() => void price()} data-testid="transcribe-price">{busy || "Price the transcript"}</button>
        ) : (
          <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(result)} onClick={() => void run()} data-testid="transcribe-run">{busy || (result ? "Transcribed" : `Transcribe · ${quote.toLocaleString()} credit${quote === 1 ? "" : "s"}`)}</button>
        )}
        {result ? (
          <>
            <button type="button" className="gx-hbtn" onClick={() => void navigator.clipboard?.writeText(result.text)} data-testid="transcribe-copy">Copy text</button>
            <button type="button" className="gx-hbtn" onClick={download} data-testid="transcribe-srt">Download subtitles (.srt)</button>
          </>
        ) : null}
      </div>
      {error ? <p className="gx-reason" role="alert">{error}</p> : null}
      {result ? (
        <div className="pd-transcript" data-testid="transcript">
          <span className="gx-hint">{clock(result.seconds)}{result.language ? ` · ${result.language}` : ""}</span>
          {bySpeaker(result.words).map((line, i) => (
            <p key={i} className="pd-transcript-line"><span className="gx-eyebrow">{line.speaker == null ? clock(line.at) : `Speaker ${line.speaker + 1} · ${clock(line.at)}`}</span> {line.text}</p>
          ))}
          {!result.words.length ? <p className="pd-transcript-line">{result.text || "No speech was found in this take."}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
