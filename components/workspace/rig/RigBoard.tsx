"use client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Heading, Pencil, StickyNote } from "lucide-react";
import { BOARD_TEXT_LIMITS } from "@/lib/workspace/rig-board";
import type { CanvasNode } from "@/lib/workbench/studio";

/*
 * The Rig board's own pieces (lib/workspace/rig-board.ts): section titles,
 * notes edited right on the card, and the buttons that add them. The graph
 * (RigGraph.tsx) places them; everything they change goes through the Rig's
 * draft and the team canvas like any other edit.
 */

export type BoardField = "title" | "text";

/**
 * Words edited on the card itself: a note's text, or a section's name. It
 * opens focused, with the caret at the end. Enter (⌘/Ctrl-Enter in a note)
 * or moving away keeps the words; Esc leaves them as they were.
 */
export function BoardEditor({ field, value, label, onCommit, onCancel }: {
  field: BoardField; value: string; label: string; onCommit: (value: string) => void; onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = input.current ?? area.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit((input.current ?? area.current)?.value ?? value);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === "Enter" && (field === "title" || e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); commit(); }
  };
  return field === "title" ? (
    <input ref={input} className="pxw-graph-editor pxw-graph-live" data-testid="rig-board-editor" aria-label={label} defaultValue={value} maxLength={BOARD_TEXT_LIMITS.title} enterKeyHint="done" onBlur={commit} onKeyDown={keys} />
  ) : (
    <textarea ref={area} className="pxw-graph-editor pxw-graph-live" data-testid="rig-board-editor" aria-label={label} defaultValue={value} maxLength={BOARD_TEXT_LIMITS.text} placeholder="Write a note" onBlur={commit} onKeyDown={keys} />
  );
}

/** The pencil on a note or a section title: edits its words on the board. */
export function EditButton({ label, onEdit }: { label: string; onEdit: () => void }) {
  return (
    <button type="button" className="pxw-graph-edit pxw-graph-live" aria-label={label} title={label} onClick={onEdit}>
      <Pencil size={13} aria-hidden="true" />
    </button>
  );
}

/** A section title on the board: its name, how many cards it holds, and a rule under them that spans its columns. */
export function SectionCard({ node, count, selected, editing, onSelect, onEdit, onCommit, onCancel }: {
  node: CanvasNode; count: number; selected: boolean; editing: boolean;
  onSelect: () => void; onEdit: () => void; onCommit: (value: string) => void; onCancel: () => void;
}) {
  return (
    <>
      <button type="button" className="pxw-graph-hit" aria-pressed={selected} aria-label={`Select section ${node.title}`} onClick={onSelect} onDoubleClick={node.locked ? undefined : onEdit} />
      {editing ? (
        <BoardEditor field="title" value={node.title} label="Section name" onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span className="pxw-graph-section-name">{node.title}</span>
      )}
      <span className="pxw-graph-section-count" data-functional-label="">{count === 1 ? "1 card" : `${count.toLocaleString("en-US")} cards`}</span>
      {editing || node.locked ? null : <EditButton label={`Rename section ${node.title}`} onEdit={onEdit} />}
    </>
  );
}

/**
 * Add to the board: a note, or a section title. Each opens ready to type (words
 * open elsewhere are kept first, as moving away from them always keeps them).
 * Free, like every edit on the canvas.
 */
export function BoardTools({ onAdd }: { onAdd: (kind: "note" | "section") => void }) {
  return (
    <div className="pxw-graph-tools" role="group" aria-label="Add to the board">
      <button type="button" data-testid="rig-add-note" aria-label="Add a note to the board" onClick={() => onAdd("note")}>
        <StickyNote size={14} aria-hidden="true" /><span>Note</span>
      </button>
      <button type="button" data-testid="rig-add-section" aria-label="Add a section title to the board" onClick={() => onAdd("section")}>
        <Heading size={14} aria-hidden="true" /><span>Section</span>
      </button>
    </div>
  );
}
