"use client";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import "./bar.css";

/**
 * The bar (docs/redesign/inventory.md § 5.8): one component for Home, Make and the boards. A row of [+] Attach, [@]
 * mention, the chips the screen hands in (a picked tile, an attached file, a selection), the words, and the one send
 * button with its price from the quote layer (`<Price>`, components/v12/ui/Price.tsx). An optional sheet sits above the
 * row (Home's picked tile: Length and Aspect). The bar holds no money of its own: the screen passes the price and says
 * whether the button can be pressed.
 *
 * Keys: Enter sends, Escape closes the mention list first. "@" typed at the start of a word, or the @ button, opens the
 * list of things to mention; picking one puts "@Name " into the words.
 */
export type BarMention = { id: string; name: string; kind: string; thumb?: string | null; media?: "image" | "video" | null };

export type BarSend = {
  label: string;
  /** The price, drawn by the screen (`<Price>`): "Start · up to N cr". Omitted for a free or unpriced send. */
  price?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  /** The hover: the price's dollar value, or why it cannot be pressed. */
  title?: string;
  testId?: string;
  /** Home's Start is the screen's one filled primary; a board's Ask is outlined. */
  variant?: "filled" | "outlined";
  /** The spend opt-in (lib/spend spendAttrsOf) for a send that spends. */
  attrs?: Record<string, string | boolean | undefined>;
};

export type BarProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** The words' accessible name. */
  label?: string;
  send: BarSend;
  /** Files picked with [+]. Absent: the button is not drawn. */
  onAttach?: (files: File[]) => void;
  attachAccept?: string;
  /** What [@] lists. Absent: the button is not drawn. */
  mentions?: readonly BarMention[];
  mentionsTitle?: string;
  /** Chips between [@] and the words (BarChip). */
  chips?: ReactNode;
  /** Above the row, inside the bar. */
  sheet?: ReactNode;
  /** One line under the row: a refusal, or what an attach read. */
  note?: { tone: "note" | "problem"; text: string } | null;
  disabled?: boolean;
  maxLength?: number;
  testId?: string;
};

export function Bar(props: BarProps) {
  const { value, onChange, onSubmit, placeholder, label = "Prompt", send, onAttach, attachAccept, mentions, mentionsTitle = "From the library", chips, sheet, note, disabled, maxLength, testId = "v12-bar" } = props;
  const input = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const listId = useId();
  /* The list closes on its own when there is nothing in it. */
  const listOpen = mentionOpen && Boolean(mentions?.length);

  const mention = (m: BarMention) => {
    const base = /(^|\s)@$/.test(value) ? value.slice(0, -1) : value.length && !/\s$/.test(value) ? `${value} ` : value;
    onChange(`${base}@${m.name} `);
    setMentionOpen(false);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && listOpen) { e.preventDefault(); e.stopPropagation(); setMentionOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!send.disabled && !send.busy && !disabled) onSubmit();
    }
  };
  const canSend = !send.disabled && !send.busy && !disabled;

  return (
    <div className="v12-bar" data-testid={testId}>
      {listOpen && mentions ? (
        <div className="v12-bar-pop" role="listbox" id={listId} aria-label={mentionsTitle} data-testid={`${testId}-mentions`}>
          <div className="v12-bar-pop-head">{mentionsTitle}</div>
          {mentions.map((m) => (
            <button key={m.id} type="button" role="option" aria-selected={false} className="v12-bar-pop-row" onClick={() => mention(m)} data-testid={`${testId}-mention`}>
              <span className="v12-bar-pop-thumb" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, already sized */}
                {m.thumb ? (m.media === "video" ? <video src={m.thumb} muted playsInline preload="metadata" /> : <img src={m.thumb} alt="" />) : null}
              </span>
              <span className="v12-bar-pop-name">{m.name}</span>
              <span className="v12-bar-pop-kind">{m.kind}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="v12-bar-card" data-disabled={disabled ? "" : undefined}>
        {sheet}
        <div className="v12-bar-row">
          {onAttach ? (
            <>
              <button type="button" className="v12-bar-icon v12-bar-plus" onClick={() => files.current?.click()} disabled={disabled}
                title="Attach a file or a Library item — Upload a file, or pick from the Library." aria-label="Attach a file" data-testid={`${testId}-attach`}>+</button>
              <input ref={files} type="file" multiple hidden tabIndex={-1} accept={attachAccept} data-testid={`${testId}-attach-input`}
                onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; if (list.length) onAttach(list); }} />
            </>
          ) : null}
          {mentions ? (
            <button type="button" className="v12-bar-icon v12-bar-at" onClick={() => setMentionOpen((open) => !open)} disabled={disabled || !mentions.length}
              title={mentions.length ? "Mention something from the library" : "Nothing in the library to mention yet"} aria-label="Mention something from the library"
              aria-expanded={listOpen} aria-controls={listOpen ? listId : undefined} data-testid={`${testId}-mention-button`}>@</button>
          ) : null}
          {chips}
          <input ref={input} className="v12-bar-input" value={value} placeholder={placeholder} aria-label={label} maxLength={maxLength} disabled={disabled}
            onChange={(e) => { const next = e.target.value; onChange(next); if (mentions?.length && /(^|\s)@$/.test(next)) setMentionOpen(true); }}
            onKeyDown={onKey} data-testid={`${testId}-input`} />
          <button type="button" className={send.variant === "outlined" ? "v12-bar-send v12-bar-send-outlined" : "v12-bar-send"} onClick={() => canSend && onSubmit()}
            disabled={!canSend} aria-busy={send.busy || undefined} title={send.title} data-testid={send.testId ?? `${testId}-send`} {...send.attrs}>
            {send.busy ? (send.busyLabel ?? `${send.label}…`) : send.price ? <span>{send.label} · {send.price}</span> : send.label}
          </button>
        </div>
      </div>
      {note ? <p className={note.tone === "problem" ? "v12-bar-note v12-bar-problem" : "v12-bar-note"} role={note.tone === "problem" ? "alert" : "status"} data-testid={`${testId}-note`}>{note.text}</p> : null}
    </div>
  );
}

/** A chip in the bar: a picked tile (with its picture), an attached file, a selection. × removes it. */
export function BarChip({ label, thumb, media, onRemove, removeTitle = "Remove", tone, testId }: {
  label: ReactNode;
  thumb?: string | null;
  media?: "image" | "video" | null;
  onRemove?: () => void;
  removeTitle?: string;
  /** "picked": a filled chip with a picture (Home's picked tile); otherwise an outlined one (a file). */
  tone?: "picked" | "file";
  testId?: string;
}) {
  return (
    <span className={tone === "picked" ? "v12-bar-chip v12-bar-chip-picked" : "v12-bar-chip"} data-testid={testId}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, already sized */}
      {thumb ? (media === "video" ? <video className="v12-bar-chip-thumb" src={thumb} muted playsInline preload="metadata" aria-hidden="true" /> : <img className="v12-bar-chip-thumb" src={thumb} alt="" />) : null}
      <span className="v12-bar-chip-label">{label}</span>
      {onRemove ? <button type="button" className="v12-bar-chip-x" onClick={onRemove} title={removeTitle} aria-label={removeTitle}>×</button> : null}
    </span>
  );
}

/** The sheet above the bar's row: a label column and rows of pill chips (Home's picked tile: Length and Aspect). */
export function BarSheet({ rows, testId = "v12-bar-sheet" }: {
  rows: readonly { label: string; options: readonly string[]; value: string; onPick: (value: string) => void }[];
  testId?: string;
}) {
  return (
    <div className="v12-bar-sheet" data-testid={testId}>
      {rows.map((row) => (
        <div key={row.label} className="v12-bar-sheet-row" role="group" aria-label={row.label}>
          <span className="v12-bar-sheet-label">{row.label}</span>
          <span className="v12-bar-sheet-chips">
            {row.options.map((option) => (
              <button key={option} type="button" className="v12-bar-pill" aria-pressed={row.value === option} onClick={() => row.onPick(option)}
                data-testid={`${testId}-${row.label.toLowerCase()}`} data-value={option}>{option}</button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
