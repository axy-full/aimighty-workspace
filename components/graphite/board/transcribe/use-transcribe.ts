"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { exact, type PriceValue } from "@/lib/shell/price-words";
import { readPendingGeneration, type PendingGeneration } from "@/lib/workbench/pending-generation";
import {
  sendingElsewhere, sendTranscription, settlePendingTranscription, transcriptionBody, transcriptionSlot,
  type TranscriptionOutcome, type TranscriptionSource, type TranscriptResult,
} from "@/lib/workbench/transcription-request";
import { readSaved, savedFrom, subscribeSaved, writeSaved, type SavedTranscript } from "./transcript-model";

/*
 * A paid transcription of one stored original, for a card on the board (gap screens, Transcribe). This is the existing path
 * and its claim-before-send recovery (lib/workbench/transcription-request.ts), moved out of the old Takes panel: priced by the
 * server first (POST /api/audio/transcribe with quoteOnly), sent only by a person's press at exactly that price (`maxCredits`),
 * claimed in a recovery slot before it is sent and never sent twice. A request whose reply never came back is asked about by
 * its own key as soon as the card sees it; a finished transcript comes back with nothing sent again.
 *
 * The route answers when the transcript is ready, so there is no server progress to show: the card says it is working and how
 * long it has been, and claims nothing else. A finished transcript is kept in this browser under the slot, so it is there after
 * a reload, and a person is never led to buy the same one again by accident.
 */

const SETTINGS = { diarize: true };
const UNREADABLE = "The saved transcription request cannot be read. Check Activity before starting another.";
/** How long to wait before asking again about a transcription the server has no answer for yet. */
const RECHECK_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

const listeners = new Set<() => void>();
const notifyClaims = () => listeners.forEach((listener) => listener());
function subscribeClaims(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", listener); };
}
function readSlot(slot: string): string {
  try { return window.localStorage.getItem(slot) ?? ""; } catch { return ""; }
}
const noSlot = () => "";

export type TranscribePhase = "idle" | "running" | "checking" | "done" | "failed";
export type Transcribing = {
  phase: TranscribePhase;
  /** The server's price for this source, or null while unread or unreadable. */
  price: PriceValue | null;
  pricing: "loading" | "ready" | "error";
  tryAgain: () => void;
  run: () => void;
  /** Seconds since the press, while it runs. */
  elapsed: number;
  /** What it is waiting on, or what stopped it, in words. */
  note: string;
  error: string;
  /** Credits the server says a failed request was charged: 0 means nothing was billed. Null when it did not say. */
  charged: number | null;
  /** Asks again about an unconfirmed request (never sends). */
  check: () => void;
  checkFailed: boolean;
  saved: SavedTranscript | null;
  slot: string;
};

export function useTranscribe({ scope, source, projectId, name, onDone }: {
  scope: string; source: TranscriptionSource; projectId?: string | null; name: string;
  /** Told once when this card's own press finished with a transcript. */
  onDone?: (saved: SavedTranscript) => void;
}): Transcribing {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [charged, setCharged] = useState<number | null>(null);
  const [checkRound, setCheckRound] = useState(0);
  const [checkFailed, setCheckFailed] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [startedAt, setStartedAt] = useState(0);
  const body = transcriptionBody(source, projectId, SETTINGS);
  const slot = transcriptionSlot(scope, projectId, source, SETTINGS);
  const savedRaw = useSyncExternalStore(subscribeSaved, () => JSON.stringify(readSaved(slot)), noSlot);
  const saved = useMemo(() => (savedRaw && savedRaw !== "null" ? (JSON.parse(savedRaw) as SavedTranscript) : null), [savedRaw]);
  const pricing = useStageQuotes(scope, saved ? {} : { transcript: { body, transcription: true } });
  const quote = pricing.quotes.transcript;
  const claimRaw = useSyncExternalStore(subscribeClaims, () => readSlot(slot), noSlot);
  const claim = useMemo((): { pending: PendingGeneration | null; problem: string } => {
    if (!claimRaw) return { pending: null, problem: "" };
    try { return { pending: readPendingGeneration({ getItem: () => claimRaw, setItem() {}, removeItem() {} }, slot), problem: "" }; }
    catch { return { pending: null, problem: UNREADABLE }; }
  }, [claimRaw, slot]);
  const claimed = claim.pending;
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  const take = useCallback((outcome: TranscriptionOutcome | { state: "none" }, own: boolean) => {
    notifyClaims();
    if (outcome.state === "done") {
      const next = savedFrom(name, outcome.result as TranscriptResult);
      writeSaved(slot, next);
      setNote(outcome.note); setError(""); setCharged(null); setCheckFailed(false);
      if (own) onDoneRef.current?.(next);
    } else if (outcome.state === "released") {
      setNote(outcome.failed ? "" : outcome.reason);
      setError(outcome.failed ? outcome.reason : "");
      setCharged(outcome.failed && typeof outcome.charged === "number" ? outcome.charged : null);
      setCheckFailed(false);
    } else if (outcome.state === "unknown") {
      setNote(outcome.waiting ? outcome.reason : "");
      setError(outcome.waiting ? "" : outcome.reason);
      setCharged(null);
      setCheckFailed(!outcome.waiting);
    }
  }, [name, slot]);

  /* One question at a time per claim; the rest is as the old panel had it. */
  const asking = useRef<{ key: string; inFlight: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const mounted = useRef(true);
  const [waitingOn, setWaitingOn] = useState<PendingGeneration | null>(null);
  const waited = useRef(0);
  const sentHere = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (asking.current?.timer) clearTimeout(asking.current.timer); };
  }, []);
  const ask = useCallback(async (attempt: PendingGeneration) => {
    if (sending.current) return;
    if (asking.current?.key === attempt.key && asking.current.inFlight) return;
    if (asking.current?.timer) clearTimeout(asking.current.timer);
    const current: { key: string; inFlight: boolean; timer?: ReturnType<typeof setTimeout> } = { key: attempt.key, inFlight: true };
    asking.current = current;
    const outcome = (sentHere.current.has(attempt.key) ? null : await sendingElsewhere(slot, attempt)) ?? await settlePendingTranscription({ scope, slot, attempt });
    current.inFlight = false;
    if (!mounted.current || asking.current !== current) return;
    take(outcome, false);
    if (outcome.state === "unknown" && outcome.waiting) {
      setWaitingOn(attempt);
      current.timer = setTimeout(() => setCheckRound((n) => n + 1), outcome.retryInMs ?? RECHECK_MS[Math.min(waited.current++, RECHECK_MS.length - 1)]);
    } else { setWaitingOn(null); waited.current = 0; }
  }, [scope, slot, take]);

  useEffect(() => {
    const attempt = claimed ?? waitingOn;
    if (!attempt || saved) return;
    const timer = setTimeout(() => void ask(attempt), 0);
    return () => clearTimeout(timer);
    // The claim's key, a recheck and Try again decide when to ask; the claim object is the one read with that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimed?.key, checkRound, saved, ask]);

  const run = useCallback(async () => {
    if (quote?.credits == null || sending.current || busy || saved || claimed || waitingOn || claim.problem) return;
    sending.current = true;
    setStartedAt(Date.now()); setClockNow(Date.now());
    setBusy(true); setError(""); setNote(""); setCharged(null); setCheckFailed(false);
    let outcome: TranscriptionOutcome;
    try {
      outcome = await sendTranscription({ scope, slot, body: { ...body, maxCredits: quote.credits }, credits: quote.credits, onSent: (key) => sentHere.current.add(key) });
    } finally { sending.current = false; setBusy(false); }
    take(outcome, true);
    /* Refused because the estimate moved: the button shows the new one, and only a new press approves it. */
    if (outcome.state === "released" && outcome.repriced != null) pricing.reprice("transcript", outcome.repriced);
    if (outcome.state === "unknown") { setCheckFailed(false); setCheckRound((n) => n + 1); }
    // body and pricing are rebuilt each render from the same inputs; the press reads the price shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.credits, busy, saved, claimed, waitingOn, claim.problem, scope, slot, take]);

  /* Seconds since the press, only while it runs. */
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const elapsed = busy ? Math.max(0, Math.floor((clockNow - startedAt) / 1000)) : 0;

  const unconfirmed = claimed ?? waitingOn;
  const pending = Boolean(unconfirmed) && !saved;
  const phase: TranscribePhase = saved ? "done" : busy ? "running" : pending ? "checking" : error || claim.problem ? "failed" : "idle";
  const problem = claim.problem || error || (!pending && !saved ? quote?.error ?? "" : "");
  return {
    phase,
    price: quote?.credits != null ? exact(quote.credits) : null,
    pricing: quote?.credits != null ? "ready" : quote?.error ? "error" : "loading",
    tryAgain: () => pricing.tryAgain("transcript"),
    run: () => void run(),
    elapsed, note: note || (pending && !problem ? "Checking your last transcription. Nothing is sent again." : ""), error: problem, charged,
    check: () => { setError(""); setCheckFailed(false); setCheckRound((n) => n + 1); },
    checkFailed, saved, slot,
  };
}
