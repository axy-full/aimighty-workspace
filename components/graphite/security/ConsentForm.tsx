"use client";
import { useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ATTEST_LINE, CONSENT_USES, USE_LABEL, dayOf, type ConsentRecord } from "@/lib/security/consent-words";
import { ownLiveTicks } from "@/lib/security/identity-card";
import { useConsents, type ConsentDraft } from "@/lib/security/use-consents";
import "./security.css";

/*
 * The consent tick a PERSON gives (Gaps A, "?view=board&gap=identity&state=consent"; phone "screen=consent"). A tick,
 * not a gate (owner, 23 Oct 2026). The form is the reading person's own tick: it opens on their live tick when they
 * have one (ticked, its details filled) and unticked when they have none, whoever else has ticked. The details are
 * folded away and optional, kept for the lawyer's NOC: whose face and voice it is, what it covers, the uses allowed, an
 * end date, a recording of that person saying they agree, and the attest box. Nothing waits on any of it.
 * The tick is never inferred: only the person's own click on "Consent given" ticks it; a detail does not.
 * Save: ticked, it adds the details to their live tick in place (merged; its file is never dropped; who ticked and
 * when stay theirs), or makes their tick when they have none. Unticked, it withdraws their own live ticks (the same
 * set the card's untick withdraws); with none, it saves nothing and says so. Ticking is a person's press in a
 * signed-in browser; the route refuses tokens and agents, so Atomik can't do this.
 *
 * The recording is made here with the microphone (or a sound or video file the person already has) and stored apart
 * from uploads, where only the recorder, an owner or an admin can play it; nothing is sent anywhere else. Nothing
 * here spends.
 */

/* "kept": the live tick's own recording, left as it is unless a new one is made. */
/* The tick's file: a recording of the person agreeing, or their signed release (a PDF, a document for the lawyer). */
type FileKind = "recording" | "document";
type Rec = { state: "none" } | { state: "kept"; url: string | null; kind: FileKind } | { state: "recording"; started: number } | { state: "uploading" }
  | { state: "done"; uploadId: string; url: string | null; seconds: number | null; when: string; kind: FileKind };

const secondsWords = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

type FormProps = {
  scope: string; projectId: string; subjectKey: string; subjectLabel: string;
  /** The saved tick, or null when the live tick was withdrawn (the box was unticked). */
  onDone: (consent: ConsentRecord | null) => void; onCancel: () => void; layout: "dialog" | "phone";
};

/** Reads the cast member's ticks first, so the form opens on the live tick when there is one. */
export function ConsentForm(props: FormProps) {
  const { state } = useConsents(props.scope, props.projectId);
  if (state.status === "idle" || state.status === "loading") {
    return <p className="gsec-sub" role="status" data-testid="consent-reading">Reading…</p>;
  }
  const own = state.status === "ready" ? ownLiveTicks(state.consents, props.subjectKey) : [];
  return <TickForm {...props} own={own} />;
}

function TickForm({ scope, projectId, subjectKey, subjectLabel, onDone, onCancel, layout, own }: FormProps & { own: ConsentRecord[] }) {
  /* The person's own newest live tick, if any: the one the form edits. */
  const live = own[0] ?? null;
  const { record, update, withdraw } = useConsents(scope, projectId);
  const scoped = useScopedFetch(scope);
  /* The tick: unticked until the person ticks it, or ticked, its details filled, when it is already on file. Every
     detail is optional. */
  const [ticked, setTicked] = useState(live != null);
  const [personName, setPersonName] = useState(live?.personName ?? "");
  const [face, setFace] = useState(live?.face ?? false);
  const [voice, setVoice] = useState(live?.voice ?? false);
  const [uses, setUses] = useState<string[]>(live ? [...live.uses] : []);
  const [other, setOther] = useState<string | null>(live?.otherUse ? live.otherUse : null);
  const [until, setUntil] = useState(live?.untilAt != null ? dayOf(live.untilAt) : "");
  const [earliest] = useState(() => dayOf(Date.now() + 86_400_000));
  const [attested, setAttested] = useState(live?.attested ?? false);
  /* A failed new recording falls back to the tick's own file. */
  const kept: Rec = live?.hasRecording ? { state: "kept", url: live.recordingUrl, kind: live.fileKind ?? "recording" } : { state: "none" };
  const [rec, setRec] = useState<Rec>(kept);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => { first.current?.focus(); }, []);
  const restore = () => setRec(kept);
  useEffect(() => () => {
    media.current?.stream.getTracks().forEach((t) => t.stop());
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  const store = async (blob: Blob, name: string, seconds: number | null) => {
    setRec({ state: "uploading" }); setProblem(null);
    try {
      /* Its own store, never an upload (review of #558, M2): not in the library, not a reference, not a token's. */
      const type = (blob.type || (/\.wav$/i.test(name) ? "audio/wav" : /\.pdf$/i.test(name) ? "application/pdf" : "audio/webm")).split(";")[0];
      const response = await scoped("/api/identity-consents/recording", { method: "POST", headers: { "Content-Type": type }, body: blob });
      const body = await response.json().catch(() => null) as { recording?: { id: string }; error?: string } | null;
      if (!response.ok || !body?.recording) throw new Error(body?.error ?? "The file could not be saved. Try again.");
      const stored = { id: body.recording.id, durationS: null as number | null };
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      const kind: FileKind = type === "application/pdf" ? "document" : "recording";
      setRec({ state: "done", uploadId: stored.id, url: objectUrl.current, seconds: seconds ?? stored.durationS, when: kind === "document" ? "added just now" : "recorded just now", kind });
    } catch (error) {
      restore();
      setProblem(error instanceof Error && error.message ? error.message : "The file could not be saved. Try again.");
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
        if (!blob.size) { restore(); setProblem("Nothing was recorded. Try again."); return; }
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

  /* A detail is only a detail: the tick is the person's own click on "Consent given", never inferred from typing. */
  const detail = (fn: () => void) => { fn(); setProblem(null); };
  const toggleUse = (use: string) => detail(() => setUses((all) => (all.includes(use) ? all.filter((u) => u !== use) : [...all, use])));
  /* A recording still saving is waited for rather than dropped; nothing else holds Save. */
  const why = rec.state === "recording" || rec.state === "uploading" ? "The recording is still saving." : null;

  const save = async () => {
    if (why || busy) { if (why) setProblem(why); return; }
    /* Unticked with no tick of theirs on file: nothing is saved, and the form says so (or closes, if nothing was given). */
    if (!ticked && !live) {
      const gave = personName.trim() || face || voice || uses.length || (other ?? "").trim() || until || attested || rec.state === "done";
      if (gave) { setProblem("Nothing saved. Tick Consent given to keep these details."); return; }
      onCancel();
      return;
    }
    setBusy(true); setProblem(null);
    if (!ticked) {
      /* Unticked: withdraw this person's own live ticks, the same set the card's untick withdraws. */
      let failed: string | null = null;
      for (const r of own) failed = (await withdraw(r.id)) ?? failed;
      setBusy(false);
      if (failed) { setProblem(failed); return; }
      onDone(null);
      return;
    }
    const draft: ConsentDraft = {
      projectId, subjectKey, subjectLabel, personName: personName.trim(), face, voice,
      uses, otherUse: (other ?? "").trim(), until, attested,
      /* A file made here is attached; a tick's own file is never dropped (the server keeps it either way). */
      ...(rec.state === "done" ? { recordingId: rec.uploadId } : {}),
    };
    const out = live ? await update(live.id, draft) : await record(draft);
    setBusy(false);
    if (out.error || !out.consent) { setProblem(out.error ?? "The consent could not be saved."); return; }
    onDone(out.consent);
  };

  const chip = (on: boolean, label: string, onClick: () => void, testId: string) => (
    <button key={testId} type="button" className="gsec-chip" aria-pressed={on} onClick={onClick} data-testid={testId}>{on ? "✓ " : ""}{label}</button>
  );

  return (
    <form className="gsec-form" data-layout={layout} onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="consent-form">
      <div className="gsec-head">
        <strong className="gsec-title" id="consent-title">Consent{subjectLabel ? ` · ${subjectLabel}` : ""}</strong>
        <span className="gsec-sub">Only a person can tick this. Atomik can’t.</span>
      </div>
      <label className="gsec-attest" data-testid="consent-tick">
        <input ref={first} type="checkbox" checked={ticked} onChange={(e) => { setTicked(e.target.checked); setProblem(null); }} data-testid="consent-tick-box" />
        <span className="gsec-check" aria-hidden="true">{ticked ? "✓" : ""}</span>
        <span>Consent given</span>
      </label>
      <details className="gsec-more" data-testid="consent-more">
        <summary className="gsec-more-head" data-testid="consent-more-head">Details · optional</summary>
        <div className="gsec-more-body">
          <label className="gsec-field">
            <span className="gsec-eyebrow">Whose face or voice</span>
            <input className="gsec-input" value={personName} maxLength={120} autoComplete="off" placeholder="Full name, as on their release"
              onChange={(e) => { const v = e.target.value; detail(() => setPersonName(v)); }} data-testid="consent-person" />
          </label>
          <div className="gsec-field" role="group" aria-label="What it covers">
            <span className="gsec-eyebrow">What it covers</span>
            <div className="gsec-chips">
              {chip(face, "Face", () => detail(() => setFace((v) => !v)), "consent-face")}
              {chip(voice, "Voice", () => detail(() => setVoice((v) => !v)), "consent-voice")}
            </div>
          </div>
          <div className="gsec-field" role="group" aria-label="Uses allowed">
            <span className="gsec-eyebrow">Uses allowed</span>
            <div className="gsec-chips">
              {CONSENT_USES.map((use) => chip(uses.includes(use), USE_LABEL[use], () => toggleUse(use), `consent-use-${use}`))}
              {chip(other !== null, "Anything else", () => detail(() => setOther((v) => (v === null ? "" : null))), "consent-use-other")}
            </div>
            {other !== null ? <input className="gsec-input" value={other} maxLength={200} placeholder="What else they allowed" onChange={(e) => { const v = e.target.value; detail(() => setOther(v)); }} data-testid="consent-other" /> : null}
          </div>
          <label className="gsec-field">
            <span className="gsec-eyebrow">Until</span>
            <input className="gsec-input" type="date" value={until} min={earliest} onChange={(e) => { const v = e.target.value; detail(() => setUntil(v)); }} data-testid="consent-until" />
          </label>
          <div className="gsec-field">
            <span className="gsec-eyebrow">Recording or signed release</span>
            <div className="gsec-rec" data-testid="consent-recording">
              <span className="gsec-rec-words">
                <span>The person agreeing, or their signed release (PDF)</span>
                <span className="gsec-sub" data-testid="consent-recording-state">
                  {rec.state === "done" ? `${rec.kind === "document" ? "signed release" : "statement"}${rec.seconds ? ` · ${secondsWords(rec.seconds)}` : ""} · ${rec.when}`
                    : rec.state === "kept" ? (rec.kind === "document" ? "signed release on file" : "statement on file")
                    : rec.state === "recording" ? "Recording… press Stop when they have said it"
                    : rec.state === "uploading" ? "Saving the file…"
                    : "Nothing added yet"}
                </span>
              </span>
              <span className="gsec-rec-acts">
                {rec.state === "recording" ? <button type="button" className="gsec-btn" onClick={stop} data-testid="consent-stop">Stop</button> : null}
                {(rec.state === "done" || rec.state === "kept") && rec.url && rec.kind === "recording" ? <button type="button" className="gsec-btn" onClick={() => void new Audio(rec.url!).play().catch(() => setProblem("This recording can't play here."))} data-testid="consent-play">Play</button> : null}
                {(rec.state === "done" || rec.state === "kept") && rec.url && rec.kind === "document" ? <a className="gsec-btn" href={rec.url} download="signed-release.pdf" data-testid="consent-open">Open</a> : null}
                {/* A tick's own file is kept for good: it is played, never replaced. */}
                {rec.state === "none" || rec.state === "done" ? (
                  <button type="button" className="gsec-btn" onClick={() => void start()} data-testid="consent-record">{rec.state === "none" ? "Record" : "Record again"}</button>
                ) : null}
                {rec.state === "none" ? <button type="button" className="gsec-btn" onClick={() => file.current?.click()} data-testid="consent-file">Use a file</button> : null}
                <input ref={file} type="file" accept="audio/*,video/*,application/pdf" hidden onChange={(e) => pick(e.target.files?.[0])} data-testid="consent-file-input" />
              </span>
            </div>
          </div>
          <label className="gsec-attest" data-testid="consent-attest">
            <input type="checkbox" checked={attested} onChange={(e) => { const v = e.target.checked; detail(() => setAttested(v)); }} data-testid="consent-attest-box" />
            <span className="gsec-check" aria-hidden="true">{attested ? "✓" : ""}</span>
            <span>{ATTEST_LINE}</span>
          </label>
        </div>
      </details>
      {problem ? <p className="gsec-problem" role="alert" data-testid="consent-problem">{problem}</p> : null}
      <div className="gsec-acts">
        <button type="button" className="gsec-btn" onClick={onCancel} data-testid="consent-cancel">Cancel</button>
        <button type="submit" className="gsec-btn gsec-primary" aria-disabled={why != null || busy || undefined} title={why ?? undefined} data-testid="consent-save">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {why && !problem ? <span className="gsec-sub gsec-why" data-testid="consent-why">{why}</span> : null}
    </form>
  );
}
