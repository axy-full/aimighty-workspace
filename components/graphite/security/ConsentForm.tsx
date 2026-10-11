"use client";
import { useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ATTEST_LINE, CONSENT_USES, USE_LABEL, dayOf, type ConsentRecord } from "@/lib/security/consent-words";
import { useConsents, type ConsentDraft } from "@/lib/security/use-consents";
import "./security.css";

/*
 * The consent step a PERSON completes (Gaps A, "?view=board&gap=identity&state=consent"; phone "screen=consent"):
 * whose face and voice it is, what it covers, the uses allowed, the end date, a recording of that person saying they
 * agree, and the attest box. Record consent is a person's press in a signed-in browser; the route refuses tokens and
 * agents, so Atomik can't do this.
 *
 * The recording is made here with the microphone (or a sound or video file the person already has) and stored apart
 * from uploads, where only the recorder, an owner or an admin can play it; nothing is sent anywhere else. Nothing
 * here spends.
 */

type Rec = { state: "none" } | { state: "recording"; started: number } | { state: "uploading" } | { state: "done"; uploadId: string; url: string | null; seconds: number | null; when: string };

const ONE_YEAR = 365 * 86_400_000;
const secondsWords = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

export function ConsentForm({ scope, projectId, subjectKey, subjectLabel, onDone, onCancel, layout }: {
  scope: string; projectId: string; subjectKey: string; subjectLabel: string;
  onDone: (consent: ConsentRecord) => void; onCancel: () => void; layout: "dialog" | "phone";
}) {
  const { record } = useConsents(scope, projectId);
  const scoped = useScopedFetch(scope);
  const [personName, setPersonName] = useState("");
  const [face, setFace] = useState(true);
  const [voice, setVoice] = useState(true);
  const [uses, setUses] = useState<string[]>(["production", "identity"]);
  const [other, setOther] = useState<string | null>(null);
  const [until, setUntil] = useState(() => dayOf(Date.now() + ONE_YEAR));
  const [earliest] = useState(() => dayOf(Date.now() + 86_400_000));
  const [attested, setAttested] = useState(false);
  const [rec, setRec] = useState<Rec>({ state: "none" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => () => {
    media.current?.stream.getTracks().forEach((t) => t.stop());
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  const store = async (blob: Blob, name: string, seconds: number | null) => {
    setRec({ state: "uploading" }); setProblem(null);
    try {
      /* Its own store, never an upload (review of #558, M2): not in the library, not a reference, not a token's. */
      const type = (blob.type || (/\.wav$/i.test(name) ? "audio/wav" : "audio/webm")).split(";")[0];
      const response = await scoped("/api/identity-consents/recording", { method: "POST", headers: { "Content-Type": type }, body: blob });
      const body = await response.json().catch(() => null) as { recording?: { id: string }; error?: string } | null;
      if (!response.ok || !body?.recording) throw new Error(body?.error ?? "The recording could not be saved. Try again.");
      const stored = { id: body.recording.id, durationS: null as number | null };
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      setRec({ state: "done", uploadId: stored.id, url: objectUrl.current, seconds: seconds ?? stored.durationS, when: "recorded just now" });
    } catch (error) {
      setRec({ state: "none" });
      setProblem(error instanceof Error && error.message ? error.message : "The recording could not be saved. Try again.");
    }
  };

  const start = async () => {
    setProblem(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setProblem("This browser can't record here. Use a recording you already have.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const started = Date.now();
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        media.current = null;
        if (!blob.size) { setRec({ state: "none" }); setProblem("Nothing was recorded. Try again."); return; }
        void store(blob, `consent-statement.${/mp4/.test(blob.type) ? "m4a" : "webm"}`, (Date.now() - started) / 1000);
      };
      media.current = { recorder, stream, chunks };
      recorder.start();
      setRec({ state: "recording", started });
    } catch {
      setProblem("The microphone isn't available. Allow it, or use a recording you already have.");
    }
  };
  const stop = () => media.current?.recorder.stop();
  const pick = (f: File | undefined) => { if (f) void store(f, f.name, null); };

  const toggleUse = (use: string) => setUses((all) => (all.includes(use) ? all.filter((u) => u !== use) : [...all, use]));
  const why = !personName.trim() ? "Write whose face or voice it is."
    : !face && !voice ? "Choose what it covers."
    : !uses.length && !(other ?? "").trim() ? "Choose at least one use."
    : !until ? "Choose the last day it holds."
    : rec.state !== "done" ? "Add the recording of the person agreeing."
    : !attested ? "Tick the statement first."
    : null;

  const save = async () => {
    if (why || busy || rec.state !== "done") { if (why) setProblem(why); return; }
    setBusy(true); setProblem(null);
    const draft: ConsentDraft = {
      projectId, subjectKey, subjectLabel, personName: personName.trim(), face, voice,
      uses, otherUse: (other ?? "").trim(), until, recordingId: rec.uploadId, attested,
    };
    const out = await record(draft);
    setBusy(false);
    if (out.error || !out.consent) { setProblem(out.error ?? "The consent could not be recorded."); return; }
    onDone(out.consent);
  };

  const chip = (on: boolean, label: string, onClick: () => void, testId: string) => (
    <button key={testId} type="button" className="gsec-chip" aria-pressed={on} onClick={onClick} data-testid={testId}>{on ? "✓ " : ""}{label}</button>
  );

  return (
    <form className="gsec-form" data-layout={layout} onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="consent-form">
      <div className="gsec-head">
        <strong className="gsec-title" id="consent-title">Record consent{subjectLabel ? ` · ${subjectLabel}` : ""}</strong>
        <span className="gsec-sub">Only a person can record this. Atomik can’t.</span>
      </div>
      <label className="gsec-field">
        <span className="gsec-eyebrow">Whose face or voice</span>
        <input ref={first} className="gsec-input" value={personName} maxLength={120} autoComplete="off" placeholder="Full name, as on their release"
          onChange={(e) => { setPersonName(e.target.value); setProblem(null); }} data-testid="consent-person" />
      </label>
      <div className="gsec-field" role="group" aria-label="What it covers">
        <span className="gsec-eyebrow">What it covers</span>
        <div className="gsec-chips">
          {chip(face, "Face", () => setFace((v) => !v), "consent-face")}
          {chip(voice, "Voice", () => setVoice((v) => !v), "consent-voice")}
        </div>
      </div>
      <div className="gsec-field" role="group" aria-label="Uses allowed">
        <span className="gsec-eyebrow">Uses allowed</span>
        <div className="gsec-chips">
          {CONSENT_USES.map((use) => chip(uses.includes(use), USE_LABEL[use], () => toggleUse(use), `consent-use-${use}`))}
          {chip(other !== null, "Anything else", () => setOther((v) => (v === null ? "" : null)), "consent-use-other")}
        </div>
        {other !== null ? <input className="gsec-input" value={other} maxLength={200} placeholder="What else they allowed" onChange={(e) => setOther(e.target.value)} data-testid="consent-other" /> : null}
      </div>
      <label className="gsec-field">
        <span className="gsec-eyebrow">Until</span>
        <input className="gsec-input" type="date" value={until} min={earliest} onChange={(e) => setUntil(e.target.value)} data-testid="consent-until" />
      </label>
      <div className="gsec-field">
        <span className="gsec-eyebrow">Recording</span>
        <div className="gsec-rec" data-testid="consent-recording">
          <span className="gsec-rec-words">
            <span>The person, saying they agree</span>
            <span className="gsec-sub" data-testid="consent-recording-state">
              {rec.state === "done" ? `statement${rec.seconds ? ` · ${secondsWords(rec.seconds)}` : ""} · ${rec.when}`
                : rec.state === "recording" ? "Recording… press Stop when they have said it"
                : rec.state === "uploading" ? "Saving the recording…"
                : "Not recorded yet"}
            </span>
          </span>
          <span className="gsec-rec-acts">
            {rec.state === "recording" ? <button type="button" className="gsec-btn" onClick={stop} data-testid="consent-stop">Stop</button> : null}
            {rec.state === "done" && rec.url ? <button type="button" className="gsec-btn" onClick={() => void new Audio(rec.url!).play().catch(() => setProblem("This recording can't play here."))} data-testid="consent-play">Play</button> : null}
            {rec.state === "none" || rec.state === "done" ? (
              <button type="button" className="gsec-btn" onClick={() => void start()} data-testid="consent-record">{rec.state === "done" ? "Record again" : "Record"}</button>
            ) : null}
            {rec.state === "none" ? <button type="button" className="gsec-btn" onClick={() => file.current?.click()} data-testid="consent-file">Use a file</button> : null}
            <input ref={file} type="file" accept="audio/*,video/*" hidden onChange={(e) => pick(e.target.files?.[0])} data-testid="consent-file-input" />
          </span>
        </div>
      </div>
      <label className="gsec-attest" data-testid="consent-attest">
        <input type="checkbox" checked={attested} onChange={(e) => { setAttested(e.target.checked); setProblem(null); }} data-testid="consent-attest-box" />
        <span className="gsec-check" aria-hidden="true">{attested ? "✓" : ""}</span>
        <span>{ATTEST_LINE}</span>
      </label>
      {problem ? <p className="gsec-problem" role="alert" data-testid="consent-problem">{problem}</p> : null}
      <div className="gsec-acts">
        <button type="button" className="gsec-btn" onClick={onCancel} data-testid="consent-cancel">Cancel</button>
        <button type="submit" className="gsec-btn gsec-primary" aria-disabled={why != null || busy || undefined} title={why ?? undefined} data-testid="consent-save">
          {busy ? "Recording consent…" : "Record consent"}
        </button>
      </div>
      {why && !problem ? <span className="gsec-sub gsec-why" data-testid="consent-why">{why}</span> : null}
    </form>
  );
}
