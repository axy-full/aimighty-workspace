"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ASPECTS, BRIEF_MAX, GLYPHS, LENGTHS, appendBrief, draftAspect, draftLength, withAspect, withLength, type HomeDraft } from "./home-model";
import { BRIEF } from "@/lib/copy";
import type { UploadedFile } from "@/lib/uploadClient";
import { attachBrief } from "./attach-brief";
import { BRIEF_ACCEPT, BRIEF_READER_LIMITS, BriefFileError, readBriefFile } from "./brief-file";
import { AttachThumbs } from "../AttachThumbs";
import { LocalTileMedia } from "../LibraryTile";

/** The references a person can add before a project exists (uploadFilesToProject's own limit). */
export const MAX_FILES = 20;
const REF_ACCEPT = "image/*,video/*";
/** A stable key per added file (the same picture added twice is two files). */
const fileKeys = new WeakMap<File, string>();
let nextKey = 0;
const keyOf = (file: File) => { let key = fileKeys.get(file); if (!key) { key = `ref:${++nextKey}`; fileKeys.set(file, key); } return key; };

export function HomeGlyph({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/**
 * "What are we making?" (the master's Home): the brief, Attach a brief (PDF or text: uploaded to the Library first, then
 * read on this device, ./attach-brief; the reader's limits said under the row, BRIEF_READER_LIMITS),
 * Add references, and the aspect and length chips. Everything here is carried into the project a template
 * makes. The footer (Atomik's thinking line and Start) is PR b's. The added files show under the box as Library tiles
 * (components/graphite/AttachThumbs), each an object URL on this device until Start or a template uploads it; pressing one
 * removes it.
 */
export function BriefBox({ draft, onDraft, refs, onRefs, briefFile, onBriefFile, onSaveBrief, busy, footer = null }: {
  draft: HomeDraft;
  onDraft: (next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => void;
  refs: File[];
  onRefs: (files: File[]) => void;
  briefFile: File | null;
  /** The attached brief, with its upload's receipt once it is in the Library (Start then files it, never uploads it again). */
  onBriefFile: (file: File | null, upload?: UploadedFile | null) => void;
  /** The chunked upload into the workspace's Library (the hook's saveBrief). */
  onSaveBrief: (file: File, onProgress: (pct: number) => void) => Promise<UploadedFile>;
  busy: boolean;
  footer?: ReactNode;
}) {
  const briefInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const reading = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
  const [readingName, setReadingName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
    setUploading(true);
    const mine = () => reading.current === controller;
    try {
      /* Into the Library first, whatever the reader then makes of it. */
      const done = await attachBrief(file, {
        save: onSaveBrief,
        read: readBriefFile,
        signal: controller.signal,
        onProgress: (pct) => { if (mine()) setStatus({ tone: "note", text: `${BRIEF.uploading} ${file.name} · ${pct}%` }); },
        onSaved: () => { if (mine()) { setUploading(false); setStatus(null); } },
        onPage: (page, total) => { if (mine()) setStatus({ tone: "note", text: `Reading ${file.name} · page ${page} of ${total}` }); },
      });
      if (!mine()) return;
      onBriefFile(file, done.upload);
      if (done.text == null) { setStatus({ tone: "note", text: done.note ?? BRIEF.savedUnread }); return; }
      const text = done.text;
      /* Onto the box as it is now: words typed while the file was read stay. */
      onDraft((now) => ({ ...now, text: appendBrief(now.text, text).text }));
      const cut = done.cut || appendBrief(draft.text, text).cut;
      setStatus(cut ? { tone: "note", text: `Kept the first ${BRIEF_MAX.toLocaleString("en-US")} characters.` } : null);
    } catch (error) {
      if (!mine()) return;
      const message = error instanceof BriefFileError || error instanceof Error ? error.message : "";
      setStatus({ tone: "problem", text: message || "This file could not be read. Try again." });
    } finally {
      if (mine()) { reading.current = null; setReadingName(null); setUploading(false); }
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

  const files = [
    ...(briefFile ? [{ key: "brief", name: briefFile.name, picture: <LocalTileMedia file={briefFile} />, testId: "home-brief-file" }] : []),
    ...refs.map((file) => ({ key: keyOf(file), name: file.name, picture: <LocalTileMedia file={file} />, testId: "home-ref" })),
  ];
  const remove = (key: string) => {
    if (key === "brief") onBriefFile(null);
    else onRefs(refs.filter((file) => keyOf(file) !== key));
  };

  return (
    <>
    <div className="gx-hm-box" data-filled={draft.text.trim() ? "" : undefined} data-testid="home-box">
      <textarea className="gx-hm-text" value={draft.text} maxLength={BRIEF_MAX} disabled={busy} aria-label="What are we making?" data-testid="home-brief"
        placeholder="A 15-second fashion film about quiet confidence. A woman crosses a sculptural desert; a mirror sphere reflects the world around her."
        onChange={(e) => onDraft({ ...draft, text: e.target.value })} />
      <div className="gx-hm-row">
        <button type="button" className="gx-hm-btn" onClick={() => briefInput.current?.click()} disabled={locked} aria-busy={readingName ? true : undefined} data-testid="home-attach">
          <HomeGlyph d={GLYPHS.doc} />{readingName ? (uploading ? `${BRIEF.uploading}…` : "Reading…") : "Attach a brief"}
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
      <p className="gx-hm-note" data-testid="home-attach-hint">{BRIEF_READER_LIMITS}</p>
      {status ? (
        <p className={status.tone === "problem" ? "gx-hm-problem" : "gx-hm-note"} role={status.tone === "problem" ? "alert" : "status"} data-testid="home-box-status">{status.text}</p>
      ) : null}
      {footer}
    </div>
    <AttachThumbs testId="home-files" items={files} disabled={locked} onRemove={remove} />
    </>
  );
}
