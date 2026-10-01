"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStageQuotes } from "./use-stage-quotes";
import { readPendingGeneration, type PendingGeneration } from "@/lib/workbench/pending-generation";
import {
  sendingElsewhere,
  sendTranscription,
  settlePendingTranscription,
  transcriptionBody,
  transcriptionSlot,
  type TranscriptionOutcome,
  type TranscriptResult,
  type TranscriptWord,
} from "@/lib/workbench/transcription-request";

/** Lines by speaker, from the timed words: "Speaker 1 · 0:04" then what they said. */
function bySpeaker(words: TranscriptWord[]): { speaker: number | null; at: number; text: string }[] {
  const lines: { speaker: number | null; at: number; text: string }[] = [];
  for (const word of words) {
    const speaker = word.speaker ?? null, last = lines.at(-1);
    if (last && last.speaker === speaker) last.text += ` ${word.text}`;
    else lines.push({ speaker, at: word.start, text: word.text });
  }
  return lines;
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const credits = (n: number) => `${n.toLocaleString()} credit${n === 1 ? "" : "s"}`;

/* The recovery slot is read live: a claim written or let go (here or in another window) redraws the panel. */
const listeners = new Set<() => void>();
const notifyClaims = () => listeners.forEach((listener) => listener());
function subscribeClaims(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readSlot(slot: string): string {
  try { return window.localStorage.getItem(slot) ?? ""; } catch { return ""; }
}
const noSlot = () => "";
/** How long to wait before asking again about a transcription the server has no answer for yet. */
const RECHECK_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
const SETTINGS = { diarize: true };
const UNREADABLE = "The saved transcription request cannot be read. Check Activity before starting another.";

/**
 * Grok transcription of a take (owner, 23 September: Grok APIs wherever
 * possible): priced by its length first, then the words — speakers told apart
 * — with subtitles to download. Billed as an xAI charge at the transcript's own
 * length, so the price on the button is approximate. Keyed by the take, so
 * choosing another take starts afresh.
 *
 * The press is claimed per source and settings before it is sent
 * (lib/workbench/transcription-request.ts). A request whose reply never came
 * back — a dropped connection, a reload, another window — is asked about by
 * its own key as soon as the panel sees it: a finished transcript comes back
 * with nothing sent again, one the server has no answer for yet is checked
 * again shortly, and one that never arrived is let go. Nothing is ever
 * re-sent on its own. A request another window is still sending is not asked
 * about until that window's POST is over (sendingElsewhere): asked sooner, its
 * key could be set aside before it arrived, and that window's press lost.
 */
export function TranscribePanel({ scope, source, name, projectId }: { scope: string; source: { genId?: string; uploadId?: string }; name: string; projectId?: string }) {
  const sending = useRef(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<TranscriptResult | null>(null);
  /* A check that could not be answered waits for Try again; each round asks once more. */
  const [checkRound, setCheckRound] = useState(0);
  const [checkFailed, setCheckFailed] = useState(false);
  const body = transcriptionBody(source, projectId, SETTINGS);
  const slot = transcriptionSlot(scope, projectId, source, SETTINGS);
  const pricing = useStageQuotes(scope, { transcript: { body, transcription: true } });
  const quote = pricing.quotes.transcript;
  const claimRaw = useSyncExternalStore(subscribeClaims, () => readSlot(slot), noSlot);
  const claim = useMemo((): { pending: PendingGeneration | null; problem: string } => {
    if (!claimRaw) return { pending: null, problem: "" };
    try {
      return { pending: readPendingGeneration({ getItem: () => claimRaw, setItem() {}, removeItem() {} }, slot), problem: "" };
    } catch {
      return { pending: null, problem: UNREADABLE };
    }
  }, [claimRaw, slot]);
  const claimed = claim.pending;

  const take = useCallback((outcome: TranscriptionOutcome | { state: "none" }) => {
    notifyClaims();
    if (outcome.state === "done") {
      setResult(outcome.result);
      setNote(outcome.note);
      setError("");
      setCheckFailed(false);
    } else if (outcome.state === "released") {
      /* Let go for good: the button is the person's again, at the price it shows now. */
      setNote(outcome.failed ? "" : outcome.reason);
      setError(outcome.failed ? outcome.reason : "");
      setCheckFailed(false);
    } else if (outcome.state === "unknown") {
      setNote(outcome.waiting ? outcome.reason : "");
      setError(outcome.waiting ? "" : outcome.reason);
      setCheckFailed(!outcome.waiting);
    }
  }, []);

  /* One question at a time per claim: a second trigger while one is on its way (the claim
     appearing and a Try again, a remount) waits for that answer rather than asking again. */
  const asking = useRef<{ key: string; inFlight: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const mounted = useRef(true);
  /* The request the server has no answer for yet, asked about again later even if another window lets its claim go. */
  const [waitingOn, setWaitingOn] = useState<PendingGeneration | null>(null);
  const waited = useRef(0);
  /* Keys this panel sent whose POST is over: asking about one cannot overtake it, so it is asked about at once. */
  const sentHere = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (asking.current?.timer) clearTimeout(asking.current.timer);
    };
  }, []);
  const ask = useCallback(async (attempt: PendingGeneration) => {
    if (sending.current) return;
    if (asking.current?.key === attempt.key && asking.current.inFlight) return;
    if (asking.current?.timer) clearTimeout(asking.current.timer);
    const current: { key: string; inFlight: boolean; timer?: ReturnType<typeof setTimeout> } = { key: attempt.key, inFlight: true };
    asking.current = current;
    /* The button says "Checking last transcription…" for as long as a request is unconfirmed. Not asked while another
       window is still sending it: that window's POST is let through first, and it is asked about after. */
    const outcome = (sentHere.current.has(attempt.key) ? null : await sendingElsewhere(slot, attempt))
      ?? await settlePendingTranscription({ scope, slot, attempt });
    current.inFlight = false;
    if (!mounted.current || asking.current !== current) return;
    take(outcome);
    if (outcome.state === "unknown" && outcome.waiting) {
      setWaitingOn(attempt);
      current.timer = setTimeout(() => setCheckRound((n) => n + 1), outcome.retryInMs ?? RECHECK_MS[Math.min(waited.current++, RECHECK_MS.length - 1)]);
    } else {
      setWaitingOn(null);
      waited.current = 0;
    }
  }, [scope, slot, take]);

  /* A claim in the slot that is not this panel's own request in flight is asked about at once,
     then again while the server has no answer for it. Asking never sends it. */
  useEffect(() => {
    const attempt = claimed ?? waitingOn;
    if (!attempt || result) return;
    /* Next tick: triggers that land together (the claim appearing, a Try again, a remount) ask once. */
    const timer = setTimeout(() => void ask(attempt), 0);
    return () => clearTimeout(timer);
    // The claim's key, a recheck and Try again decide when to ask; the claim object is the one read with that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed?.key, checkRound, result, ask]);

  async function run() {
    if (quote?.credits == null || sending.current || busy || result || claimed || waitingOn || claim.problem) return;
    sending.current = true;
    setBusy("Transcribing…"); setError(""); setNote(""); setCheckFailed(false);
    let outcome: TranscriptionOutcome;
    try {
      outcome = await sendTranscription({ scope, slot, body: { ...body, maxCredits: quote.credits }, credits: quote.credits, onSent: (key) => sentHere.current.add(key) });
    } finally {
      sending.current = false;
      setBusy("");
    }
    take(outcome);
    /* Refused because the estimate moved: the button shows the new one, and only a new press approves it. */
    if (outcome.state === "released" && outcome.repriced != null) pricing.reprice("transcript", outcome.repriced);
    /* Not known yet (the reply was lost, or the server has no answer yet): ask what became of it at once, never send it again. */
    if (outcome.state === "unknown") {
      setCheckFailed(false);
      setCheckRound((n) => n + 1);
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.srt], { type: "application/x-subrip" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name.replace(/[^\w.-]+/g, "_") || "take"}.srt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const unconfirmed = claimed ?? waitingOn;
  const pending = Boolean(unconfirmed) && !result;
  const label = busy
    || (result ? "Transcribed"
      : pending ? "Checking last transcription…"
      : quote?.credits != null ? `Transcribe · about ${credits(quote.credits)}`
      : quote?.error ? "Price unavailable" : "Pricing transcript…");
  const alert = claim.problem || error || (!pending && !result ? quote?.error ?? "" : "");
  const status = note || (pending && !alert ? `Your last transcription${unconfirmed!.credits > 0 ? ` (about ${credits(unconfirmed!.credits)})` : ""} is unconfirmed. Asking the server what became of it; nothing is sent again.` : "");
  return (
    <section className="gx-gen-card gx-workflow" aria-label="Transcribe" data-testid="transcribe" data-section="transcribe">
      <div className="gx-gen-row">
        <span className="gx-eyebrow" data-functional-label="">Transcribe · Grok</span>
        <h2 className="gx-workflow-title">What is said in this take</h2>
        <p className="gx-hint">Every word, timed, with the speakers told apart — and subtitles to download. Priced by its length first.</p>
      </div>
      <div className="gx-gen-enhance">
        <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(result) || pending || Boolean(claim.problem) || quote?.credits == null} onClick={() => void run()} data-testid="transcribe-run">
          {label}
        </button>
        {pending && checkFailed && !busy ? <button type="button" className="gx-hbtn" onClick={() => { setError(""); setCheckFailed(false); setCheckRound((n) => n + 1); }} data-testid="transcribe-check">Try again</button> : null}
        {!pending && !result && quote?.error ? <button type="button" className="gx-hbtn" onClick={() => pricing.tryAgain("transcript")}>Try again</button> : null}
        {result ? (
          <>
            <button type="button" className="gx-hbtn" onClick={() => void navigator.clipboard?.writeText(result.text)} data-testid="transcribe-copy">Copy text</button>
            <button type="button" className="gx-hbtn" onClick={download} data-testid="transcribe-srt">Download subtitles (.srt)</button>
          </>
        ) : null}
      </div>
      {status ? <p className="gx-hint" role="status" data-testid="transcribe-note">{status}</p> : null}
      {alert ? <p className="gx-reason" role="alert">{alert}</p> : null}
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
