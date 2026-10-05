"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { DOC_LIMITS, type BriefDoc, type BriefField } from "./model";
import "./doc.css";

/**
 * The brief as a document card on the board (design/particl-graphite/README.md § 3.1 d): BRIEF, the project's
 * name, what we are making, the LOOK, and the aspect · frame rate · running time. Both paragraphs are edited in
 * place; every keystroke goes to the draft through `onEdit` (the Rig seam), which saves itself.
 *
 * The design's RULE has no field in the draft today, so it is not drawn (a gap, not a placeholder).
 */
export function BriefDocCard({ doc, readOnly, onEdit, testId = "board-brief" }: {
  doc: BriefDoc;
  /** Why nothing can be edited (offline, or the sample production), or null. */
  readOnly: string | null;
  onEdit: (field: BriefField, value: string) => void;
  testId?: string;
}) {
  return (
    <article className="gx-doc" data-testid={testId} aria-label="Brief">
      <div className="gx-doc-eyebrow">Brief</div>
      <h2 className="gx-doc-title">{doc.title}</h2>
      <DocText label="What we are making" value={doc.brief} max={DOC_LIMITS.brief} placeholder="What are we making?" readOnly={readOnly} onEdit={(v) => onEdit("brief", v)} testId={`${testId}-text`} />
      <div className="gx-doc-section">
        <div className="gx-doc-eyebrow">Look</div>
        <DocText label="Look" value={doc.look} max={DOC_LIMITS.direction} placeholder="Light, colour, lenses" readOnly={readOnly} onEdit={(v) => onEdit("direction", v)} testId={`${testId}-look`} />
      </div>
      {doc.footer ? <div className="gx-doc-foot" data-testid={`${testId}-foot`}>{doc.footer}</div> : null}
    </article>
  );
}

/**
 * A paragraph edited in place: a borderless field that grows with its words. While it has focus it keeps what
 * is being typed; a change that arrives meanwhile (a teammate, a merge) shows once it loses focus.
 */
export function DocText({ label, value, max, placeholder, readOnly, onEdit, testId }: {
  label: string; value: string; max: number; placeholder: string; readOnly: string | null;
  onEdit: (value: string) => void; testId: string;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);
  /* What the draft holds now, once this field lets go of it (a teammate's change, a merge). */
  if (!focused && value !== seen) { setSeen(value); setText(value); }
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  return (
    <textarea
      ref={box}
      className="gx-doc-text nodrag nopan nowheel"
      aria-label={label}
      rows={1}
      value={text}
      placeholder={readOnly ? "" : placeholder}
      maxLength={max}
      readOnly={Boolean(readOnly)}
      title={readOnly ?? undefined}
      data-testid={testId}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        if (readOnly) return;
        setText(e.target.value);
        onEdit(e.target.value);
      }}
    />
  );
}

/**
 * A brief card from the canvas (a Rig "brief" node): its title and its text, the text edited in place. The same
 * card as the project's brief, drawn for the briefs a team placed on the board.
 */
export function NodeDocCard({ title, text, readOnly, onEdit, testId = "board-brief-node" }: {
  title: string; text: string; readOnly: string | null; onEdit: (value: string) => void; testId?: string;
}) {
  return (
    <article className="gx-doc" data-testid={testId} aria-label={title || "Brief"}>
      <div className="gx-doc-eyebrow">Brief</div>
      <h2 className="gx-doc-title">{title || "Brief"}</h2>
      <DocText label={`${title || "Brief"} text`} value={text} max={NODE_TEXT_LIMIT} placeholder="What this brief says" readOnly={readOnly} onEdit={onEdit} testId={`${testId}-text`} />
    </article>
  );
}

/** A canvas card's text limit (lib/workbench/studio-schema.ts). */
const NODE_TEXT_LIMIT = 30_000;
