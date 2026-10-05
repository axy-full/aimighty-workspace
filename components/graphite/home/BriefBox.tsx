"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ASPECTS, BRIEF_MAX, GLYPHS, LENGTHS, appendBrief, draftAspect, draftLength, withAspect, withLength, type HomeDraft } from "./home-model";
import { BRIEF_ACCEPT, BriefFileError } from "./brief-file";

/** The references a person can add before a project exists (uploadFilesToProject's own limit). */
export const MAX_FILES = 20;
const REF_ACCEPT = "image/*,video/*";

export function HomeGlyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** An added file as a chip: its picture when it is a still, its name, and Remove. The picture's object URL lives as long as the chip. */
function FileChip({ file, kind, onRemove, disabled }: { file: File; kind: "brief" | "ref"; onRemove: () => void; disabled: boolean }) {
  const still = kind === "ref" && file.type.startsWith("image/");
  return (
    <span className="gx-hm-file" data-testid={kind === "brief" ? "home-brief-file" : "home-ref"}>
      <span className="gx-hm-file-pic" aria-hidden="true">
        {still ? (
          /* A local file's preview (an object URL), not a served image: next/image has nothing to optimise. */
          /* eslint-disable-next-line @next/next/no-img-element */
          <img alt="" ref={(img) => {
            if (!img) return;
            const url = URL.createObjectURL(file);
            img.src = url;
            return () => URL.revokeObjectURL(url);
          }} />
        ) : <HomeGlyph d={kind === "brief" ? GLYPHS.doc : GLYPHS.video} />}
      </span>
      <span className="gx-hm-file-name" title={file.name}>{file.name}</span>
      <button type="button" className="gx-hm-file-x" onClick={onRemove} disabled={disabled} aria-label={`Remove ${file.name}`}>×</button>
    </span>
  );
}

/**
 * "What are we making?" (the master's Home): the brief, Attach a brief (PDF or text, read on this device),
 * Add references, and the aspect and length chips. Everything here is carried into the project a template
 * makes. The footer (Atomik's thinking line and Start) is PR b's.
 */
export function BriefBox({ draft, onDraft, refs, onRefs, briefFile, onBriefFile, busy, footer = null }: {
  draft: HomeDraft;
  onDraft: (next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => void;
  refs: File[];
  onRefs: (files: File[]) => void;
  briefFile: File | null;
  onBriefFile: (file: File | null) => void;
  busy: boolean;
  footer?: ReactNode;
}) {
  const briefInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const reading = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
  const [readingName, setReadingName] = useState<string | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const aspect = draftAspect(draft);
  const length = draftLength(draft);
  const locked = busy || Boolean(readingName);

  const attach = async (file: File | undefined) => {
    if (!file) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setStatus(null);
    setReadingName(file.name);
    try {
      const { readBriefFile } = await import("./brief-file");
      const read = await readBriefFile(file, controller.signal, (page, total) => {
        if (reading.current === controller) setStatus({ tone: "note", text: `Reading ${file.name} · page ${page} of ${total}` });
      });
      if (reading.current !== controller) return;
      /* Onto the box as it is now: words typed while the file was read stay. */
      onDraft((now) => ({ ...now, text: appendBrief(now.text, read.text).text }));
      onBriefFile(file);
      const cut = read.cut || appendBrief(draft.text, read.text).cut;
      setStatus(cut ? { tone: "note", text: `Kept the first ${BRIEF_MAX.toLocaleString("en-US")} characters.` } : null);
    } catch (error) {
      if (reading.current !== controller) return;
      const message = error instanceof BriefFileError || error instanceof Error ? error.message : "";
      setStatus({ tone: "problem", text: message || "This file could not be read. Try again." });
    } finally {
      if (reading.current === controller) { reading.current = null; setReadingName(null); }
    }
  };

  const addRefs = (list: FileList | null) => {
    const picked = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!picked.length) return;
    const room = MAX_FILES - refs.length - (briefFile ? 1 : 0);
    if (room <= 0) { setStatus({ tone: "problem", text: `Add up to ${MAX_FILES} files.` }); return; }
    onRefs([...refs, ...picked.slice(0, room)]);
    setStatus(picked.length > room ? { tone: "problem", text: `Added ${room}; up to ${MAX_FILES} files.` } : null);
  };

  return (
    <div className="gx-hm-box" data-filled={draft.text.trim() ? "" : undefined} data-testid="home-box">
      <textarea className="gx-hm-text" value={draft.text} maxLength={BRIEF_MAX} disabled={busy} aria-label="What are we making?" data-testid="home-brief"
        placeholder="A 15-second fashion film about quiet confidence. A woman crosses a sculptural desert; a mirror sphere reflects the world around her."
        onChange={(e) => onDraft({ ...draft, text: e.target.value })} />
      {briefFile || refs.length ? (
        <div className="gx-hm-files" aria-label="Added files">
          {briefFile ? <FileChip file={briefFile} kind="brief" disabled={locked} onRemove={() => onBriefFile(null)} /> : null}
          {refs.map((file, i) => (
            <FileChip key={`${file.name}:${file.size}:${file.lastModified}:${i}`} file={file} kind="ref" disabled={locked} onRemove={() => onRefs(refs.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : null}
      <div className="gx-hm-row">
        <button type="button" className="gx-hm-btn" onClick={() => briefInput.current?.click()} disabled={locked} aria-busy={readingName ? true : undefined} data-testid="home-attach">
          <HomeGlyph d={GLYPHS.doc} />{readingName ? "Reading…" : "Attach a brief"}
        </button>
        <input ref={briefInput} type="file" accept={BRIEF_ACCEPT} hidden tabIndex={-1} data-testid="home-attach-input"
          onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void attach(file); }} />
        <button type="button" className="gx-hm-btn" onClick={() => refInput.current?.click()} disabled={locked} data-testid="home-add-refs">
          <HomeGlyph d={GLYPHS.image} />Add references
        </button>
        <input ref={refInput} type="file" accept={REF_ACCEPT} multiple hidden tabIndex={-1} data-testid="home-refs-input"
          onChange={(e) => { addRefs(e.target.files); e.target.value = ""; }} />
        <span className="gx-hm-sep" aria-hidden="true" />
        <span className="gx-hm-chips" role="group" aria-label="Aspect">
          {ASPECTS.map((value) => (
            <button key={value} type="button" className="gx-hm-chip" aria-pressed={aspect === value} disabled={busy} data-testid="home-aspect" data-value={value}
              onClick={() => onDraft(withAspect(draft, value))}>{value}</button>
          ))}
        </span>
        <span className="gx-hm-sep" aria-hidden="true" />
        <span className="gx-hm-chips" role="group" aria-label="Length">
          {LENGTHS.map((value) => (
            <button key={value} type="button" className="gx-hm-chip" aria-pressed={length === value} disabled={busy} data-testid="home-length" data-value={value}
              onClick={() => onDraft(withLength(draft, value))}>{value}</button>
          ))}
        </span>
      </div>
      {status ? (
        <p className={status.tone === "problem" ? "gx-hm-problem" : "gx-hm-note"} role={status.tone === "problem" ? "alert" : "status"} data-testid="home-box-status">{status.text}</p>
      ) : null}
      {footer}
    </div>
  );
}
