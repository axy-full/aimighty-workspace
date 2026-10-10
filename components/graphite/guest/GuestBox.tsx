"use client";
import { useEffect, useRef, useState } from "react";
import { HomeGlyph } from "../home/BriefBox";
import { BRIEF_ACCEPT, BriefFileError, readBriefFile } from "../home/brief-file";
import { ASPECTS, BRIEF_MAX, GLYPHS, LENGTHS, appendBrief, draftAspect, draftLength, withAspect, withLength, type HomeDraft } from "../home/home-model";

/**
 * Home's "What are we making?" box in its guest state (Guest Home frame 1 / P1): the same words, chips and
 * classes as stream 2's BriefBox, and Attach a brief still reads a PDF or text file on this device into the box.
 * What differs: Add references opens the sign-up sheet (a guest's files are never kept), and Start is outlined,
 * with no price and no thinking line, and opens the sheet. Nothing here calls a server.
 */
export function GuestBox({ draft, onDraft, onGated }: {
  draft: HomeDraft;
  onDraft: (next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => void;
  /** Add references and Start: the sign-up sheet. */
  onGated: () => void;
}) {
  const briefInput = useRef<HTMLInputElement>(null);
  const reading = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
  const [readingName, setReadingName] = useState<string | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const aspect = draftAspect(draft);
  const length = draftLength(draft);

  const attach = async (file: File | undefined) => {
    if (!file) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setStatus(null);
    setReadingName(file.name);
    try {
      const read = await readBriefFile(file, controller.signal, (page, total) => {
        if (reading.current === controller) setStatus({ tone: "note", text: `Reading ${file.name} · page ${page} of ${total}` });
      });
      if (reading.current !== controller) return;
      onDraft((now) => ({ ...now, text: appendBrief(now.text, read.text).text }));
      setStatus(read.cut ? { tone: "note", text: `Kept the first ${BRIEF_MAX.toLocaleString("en-US")} characters.` } : null);
    } catch (error) {
      if (reading.current !== controller) return;
      const message = error instanceof BriefFileError || error instanceof Error ? error.message : "";
      setStatus({ tone: "problem", text: message || "This file could not be read. Try again." });
    } finally {
      if (reading.current === controller) { reading.current = null; setReadingName(null); }
    }
  };

  const start = () => {
    if (!draft.text.trim()) { setStatus({ tone: "problem", text: "Say what we are making, or pick a template." }); return; }
    setStatus(null);
    onGated();
  };

  return (
    <div className="gx-hm-box" data-filled={draft.text.trim() ? "" : undefined} data-testid="home-box">
      <textarea className="gx-hm-text" value={draft.text} maxLength={BRIEF_MAX} aria-label="What are we making?" data-testid="home-brief"
        placeholder="A 15-second fashion film about quiet confidence. A woman crosses a sculptural desert; a mirror sphere reflects the world around her."
        onChange={(e) => onDraft({ ...draft, text: e.target.value })} />
      <div className="gx-hm-row">
        <button type="button" className="gx-hm-btn" onClick={() => briefInput.current?.click()} disabled={Boolean(readingName)} aria-busy={readingName ? true : undefined} data-testid="home-attach">
          <HomeGlyph d={GLYPHS.doc} />{readingName ? "Reading…" : "Attach a brief"}
        </button>
        <input ref={briefInput} type="file" accept={BRIEF_ACCEPT} hidden tabIndex={-1} data-testid="home-attach-input"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void attach(file); }} />
        <button type="button" className="gx-hm-btn gx-gh-refs" onClick={onGated} data-testid="home-add-refs">
          <HomeGlyph d={GLYPHS.image} />Add references
        </button>
        <span className="gx-hm-sep" aria-hidden="true" />
        <span className="gx-hm-chips" role="group" aria-label="Aspect">
          {ASPECTS.map((value) => (
            <button key={value} type="button" className="gx-hm-chip" aria-pressed={aspect === value} data-testid="home-aspect" data-value={value}
              onClick={() => onDraft(withAspect(draft, value))}>{value}</button>
          ))}
        </span>
        <span className="gx-hm-sep" aria-hidden="true" />
        <span className="gx-hm-chips" role="group" aria-label="Length">
          {LENGTHS.map((value) => (
            <button key={value} type="button" className="gx-hm-chip" aria-pressed={length === value} data-testid="home-length" data-value={value}
              onClick={() => onDraft(withLength(draft, value))}>{value}</button>
          ))}
        </span>
      </div>
      {status ? (
        <p className={status.tone === "problem" ? "gx-hm-problem" : "gx-hm-note"} role={status.tone === "problem" ? "alert" : "status"} data-testid="home-box-status">{status.text}</p>
      ) : null}
      <div className="gx-hm-foot gx-gh-foot" data-testid="home-start-row">
        <button type="button" className="gx-gh-start" onClick={start} data-testid="home-start">Start</button>
      </div>
    </div>
  );
}
