"use client";

/**
 * A textarea whose @names show highlighted: the text is painted by an
 * overlay in the same font, and the textarea on top keeps its caret and
 * its editing while its own glyphs stay transparent.
 */
import { splitMentions } from "@/lib/mentions";

export default function MentionText({ value, onChange, known, placeholder, className = "", rows = 3 }: {
  value: string; onChange: (v: string) => void; known: string[]; placeholder?: string; className?: string; rows?: number;
}) {
  return (
    <div className={`ak-mt ${className}`}>
      <div className="ak-mt-overlay" aria-hidden="true">
        {splitMentions(value, known).map((p, i) => p.mention ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}
        {value.endsWith("\n") ? "​" : ""}
      </div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
        onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }}
        ref={(t) => { if (t) { t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; } }} />
    </div>
  );
}
