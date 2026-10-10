"use client";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useOverlay } from "@/components/v12/ui/overlay";
import { Tooltip } from "@/components/v12/ui/Tooltip";
import "./bar.css";

/**
 * The bar (docs/redesign/inventory.md § 5.8): one component for Home, Make and the boards. A row of [+] Attach, [@]
 * mention, the chips the screen hands in (a picked tile, an attached file, a selection), the words, and the one send
 * button with its price from the quote layer (`<Price>`, components/v12/ui/Price.tsx). An optional sheet sits above the
 * row (Home's picked tile: Length and Aspect). The bar holds no money of its own: the screen passes the price and says
 * whether the button can be pressed.
 *
 * Keys: Enter sends. "@" typed at the start of a word, or the @ button, opens the list of things to mention, a menu on
 * the overlay stack (Esc or a click outside closes it): ↑/↓ move through it, Enter picks, and picking puts "@Name " into
 * the words (or, with `onMention`, hands the item to the screen, as Make's references do).
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
  /** Instead of "@Name " in the words, the screen takes the picked item (Make adds it as a reference). */
  onMention?: (mention: BarMention) => void;
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
  const { value, onChange, onSubmit, placeholder, label = "Prompt", send, onAttach, attachAccept, mentions, mentionsTitle = "From the library", onMention, chips, sheet, note, disabled, maxLength, testId = "v12-bar" } = props;
  const input = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const at = useRef<HTMLButtonElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  /* The list closes on its own when there is nothing in it. */
  const listOpen = mentionOpen && Boolean(mentions?.length);
  const count = mentions?.length ?? 0;
  const current = Math.min(active, Math.max(0, count - 1));
  const openList = () => { setActive(0); setMentionOpen(true); };
  const close = () => setMentionOpen(false);
  /* A menu on the overlay stack: Esc closes it before anything under it, and so does a click outside the list, the @ and the words. */
  useOverlay("menu", listOpen, close, { refs: [pop, at, input], outside: true });

  const mention = (m: BarMention) => {
    const typed = /(^|\s)@$/.test(value) ? value.slice(0, -1) : value;
    if (onMention) { if (typed !== value) onChange(typed); onMention(m); }
    else onChange(`${typed.length && !/\s$/.test(typed) ? `${typed} ` : typed}@${m.name} `);
    setMentionOpen(false);
    input.current?.focus();
  };
  const step = (by: number) => setActive((n) => (Math.min(n, count - 1) + by + count) % count);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (listOpen && mentions && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); step(e.key === "ArrowDown" ? 1 : -1); return; }
    if (listOpen && mentions && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); mention(mentions[current]); return; }
    if (e.key === "Escape" && listOpen) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!send.disabled && !send.busy && !disabled) onSubmit();
    }
  };
  const canSend = !send.disabled && !send.busy && !disabled;

  return (
    <div className="v12-bar" data-testid={testId}>
      {listOpen && mentions ? (
        <div ref={pop} className="v12-bar-pop" role="listbox" id={listId} aria-label={mentionsTitle} data-testid={`${testId}-mentions`}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const next = (current + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
            setActive(next);
            pop.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
          }}>
          <div className="v12-bar-pop-head">{mentionsTitle}</div>
          {mentions.map((m, i) => (
            <button key={m.id} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === current} data-index={i} data-active={i === current ? "" : undefined}
              tabIndex={i === current ? 0 : -1} className="v12-bar-pop-row" onClick={() => mention(m)} onFocus={() => setActive(i)} data-testid={`${testId}-mention`}>
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
              <Tooltip name="Attach a file or a Library item" line="Upload a file, or pick from the Library." side="top">
                <button type="button" className="v12-bar-icon v12-bar-plus" onClick={() => files.current?.click()} disabled={disabled}
                  aria-label="Attach a file" data-testid={`${testId}-attach`}>+</button>
              </Tooltip>
              <input ref={files} type="file" multiple hidden tabIndex={-1} accept={attachAccept} data-testid={`${testId}-attach-input`}
                onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ""; if (list.length) onAttach(list); }} />
            </>
          ) : null}
          {mentions ? (
            <Tooltip name={mentions.length ? "Mention something from the library" : "Nothing in the library to mention yet"} side="top" named={Boolean(mentions.length)}>
              <button ref={at} type="button" className="v12-bar-icon v12-bar-at" onClick={() => { if (listOpen) close(); else { openList(); input.current?.focus(); } }} disabled={disabled || !mentions.length}
                aria-label="Mention something from the library"
                aria-expanded={listOpen} aria-controls={listOpen ? listId : undefined} data-testid={`${testId}-mention-button`}>@</button>
            </Tooltip>
          ) : null}
          {chips}
          <input ref={input} className="v12-bar-input" value={value} placeholder={placeholder} aria-label={label} maxLength={maxLength} disabled={disabled}
            role={mentions ? "combobox" : undefined} aria-expanded={mentions ? listOpen : undefined} aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? `${listId}-${current}` : undefined} aria-autocomplete={mentions ? "list" : undefined}
            onChange={(e) => { const next = e.target.value; onChange(next); if (mentions?.length && /(^|\s)@$/.test(next)) openList(); }}
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
      {onRemove ? <Tooltip name={removeTitle} named><button type="button" className="v12-bar-chip-x" onClick={onRemove} aria-label={removeTitle}>×</button></Tooltip> : null}
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
