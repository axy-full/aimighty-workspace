"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import LazyMedia from "@/components/LazyMedia";
import { BOARD_TEXT_LIMITS } from "@/lib/workspace/rig-board";
import { useBoardInternals } from "../../BoardContext";
import type { GroupData } from "@/lib/board/types";
import type { CardProps } from "../types";

/*
 * Stream 3's plain cards: today's canvas nodes drawn simply, so a production
 * opens as a board from day one, and the shared group frame. Each gives way
 * to stream 4's or stream 5's card of the same kind (or id) as it lands
 * (components/graphite/board/cards/index.ts). Notes and labels are the
 * board's own free cards and stay stream 3's.
 */

export type Preview = { url: string; video: boolean };
export type NodeCardData = {
  kicker: string;
  title: string;
  /** The card's state in words ("Approved · Director"), or null. */
  line: string | null;
  tone: "green" | "gold" | "red" | "blue" | "floor";
  text: string;
  preview: Preview | null;
  /** The media well's height in px; 0: a text card. */
  well: number;
  /** A video or audio original a card can be transcribed from (gap screens, Transcribe): its stored id, by origin. */
  source?: { genId?: string; uploadId?: string; media: "video" | "audio" };
};

export function NodeCard({ data }: CardProps<NodeCardData>) {
  return <NodeCardShell data={data} />;
}

/** The plain node card, with room under it for a card action (a media card's Transcribe). */
export function NodeCardShell({ data, children }: { data: NodeCardData; children?: ReactNode }) {
  return (
    <article className="bd-card bd-node-card" data-tone={data.tone}>
      {data.well ? (
        <span className="bd-card-well" style={{ height: data.well }}>
          {data.preview?.video ? <LazyMedia url={data.preview.url} kind="video" preview={false} />
            /* eslint-disable-next-line @next/next/no-img-element */
            : data.preview ? <img src={data.preview.url} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
        </span>
      ) : null}
      <span className="bd-card-body">
        {data.kicker ? <span className="bd-eyebrow">{data.kicker}</span> : null}
        <span className="bd-card-title">{data.title}</span>
        {data.text ? <span className="bd-card-text">{data.text}</span> : null}
        {data.line ? <span className="bd-card-line"><i aria-hidden="true" />{data.line}</span> : null}
        {children}
      </span>
    </article>
  );
}

/**
 * Words edited on the card itself: it opens focused with the caret at the end; moving away or Enter (⌘/Ctrl-Enter
 * in a note) keeps them, Esc leaves them as they were. They save themselves through the Rig's draft.
 */
function InPlace({ id, multiline, value, label }: { id: string; multiline: boolean; value: string; label: string }) {
  const { finishEdit } = useBoardInternals();
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    finishEdit(id, keep ? field.current?.value ?? value : null);
  };
  const keys = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(true); }
  };
  return multiline
    ? <textarea ref={field} className="bd-edit nodrag nopan nowheel" aria-label={label} defaultValue={value} maxLength={BOARD_TEXT_LIMITS.text} placeholder="Write a note" onBlur={() => finish(true)} onKeyDown={keys} />
    : <input ref={field} className="bd-edit bd-edit--line nodrag nopan" aria-label={label} defaultValue={value} maxLength={BOARD_TEXT_LIMITS.title} onBlur={() => finish(true)} onKeyDown={keys} />;
}

export type NoteData = { title: string; text: string };
export function NoteCard({ card, data }: CardProps<NoteData>) {
  const { editing } = useBoardInternals();
  return (
    <article className="bd-card bd-note">
      <span className="bd-eyebrow">Note</span>
      {editing === card.id ? <InPlace id={card.id} multiline value={data.text} label="Note" />
        : <span className="bd-note-text">{data.text || <span className="bd-quiet">Nothing written yet.</span>}</span>}
    </article>
  );
}

export type LabelData = { title: string };
export function LabelCard({ card, data }: CardProps<LabelData>) {
  const { editing } = useBoardInternals();
  return <div className="bd-label">{editing === card.id ? <InPlace id={card.id} multiline={false} value={data.title} label="Text" /> : data.title}</div>;
}

/** The shared group frame (README § 3.1): a 14 px hairline frame, its label on the top border. */
export function GroupFrame({ data }: CardProps<GroupData>) {
  return (
    <section className="bd-group" data-tone={data.tone} aria-label={data.title}>
      <span className="bd-group-label">
        <span className="bd-group-title">{data.title}</span>
        {data.meta ? <span className="bd-group-meta">{data.meta}</span> : null}
      </span>
    </section>
  );
}
