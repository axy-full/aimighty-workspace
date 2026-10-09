"use client";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { RegionStatus } from "@/lib/board/regions";
import { STAGE_PRESETS, type Stage } from "@/lib/v12/board/stages";
import { Menu, Tooltip, type MenuItem } from "@/components/v12/ui";

/**
 * The board's stage rail (docs/redesign/inventory.md § 6.2; prototype L254–L266): 88 px, the board kind at the top, one
 * row per stage with its marker (done ✓, needs-you count, working, skipped –, empty; the current stage ringed) and its
 * label; hover shows Rename and ⋯ (Rename, Skip this stage or Put it back, Remove, and the row's number key). Rows drag
 * to reorder; "+ Stage" adds a preset or a custom stage after the current one. Every change is one draft edit with Undo
 * (the caller's `onEdit`).
 */
export type StageEdit =
  | { type: "rename"; id: string; label: string }
  | { type: "skip"; id: string; skipped: boolean }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; index: number }
  | { type: "add"; after: string | null; label: string };

export function StageRail({ kindLabel, stages, current, status, readOnly, onPick, onEdit }: {
  kindLabel: string;
  stages: readonly Stage[];
  current: string | null;
  status: (stage: Stage) => RegionStatus;
  /** Why the rail cannot be changed (offline, the sample), or null. */
  readOnly: string | null;
  onPick: (id: string) => void;
  onEdit: (edit: StageEdit) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const addAnchor = useRef<HTMLButtonElement>(null);
  const currentLabel = stages.find((s) => s.id === current)?.label ?? null;

  const rowMenu = (stage: Stage, index: number): MenuItem[] => [
    { id: "rename", label: "Rename", onSelect: () => setRenaming(stage.id) },
    { id: "skip", label: stage.skipped ? "Put it back" : "Skip this stage", onSelect: () => onEdit({ type: "skip", id: stage.id, skipped: !stage.skipped }) },
    { id: "remove", label: "Remove", tone: "danger", disabled: stages.length <= 1, onSelect: () => onEdit({ type: "remove", id: stage.id }) },
    { separator: true, id: "sep" },
    { id: "hint", label: index < 9 ? `Drag the row to reorder · ${index + 1} jumps here` : "Drag the row to reorder", disabled: true, onSelect: () => {} },
  ];
  const addItems: MenuItem[] = [
    ...STAGE_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.line, onSelect: () => onEdit({ type: "add", after: current, label: p.label }) })),
    { id: "custom", label: "Custom…", hint: "name it", onSelect: () => onEdit({ type: "add", after: current, label: "New stage" }) },
  ];

  const drop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const id = dragging;
    setDragging(null); setOver(null);
    if (!id) return;
    const from = stages.findIndex((s) => s.id === id);
    /* The insert line sits above row `index`: in the list without the dragged row that is one less when it came from above. */
    const to = from < index ? index - 1 : index;
    if (to !== from) onEdit({ type: "move", id, index: to });
  };

  return (
    <nav className="v12-rail" aria-label="Board stages" data-testid="v12-stage-rail">
      <Tooltip name="Board kind" line={`${kindLabel} · the stages below are this kind's`}>
        <span className="v12-rail-kind" tabIndex={0} data-testid="v12-stage-kind">{kindLabel.toUpperCase()}</span>
      </Tooltip>
      <div className="v12-rail-rows">
        <span className="v12-rail-line" aria-hidden="true" />
        {stages.map((stage, index) => {
          const s = status(stage);
          const state = stage.skipped ? "skip" : s.state;
          const here = stage.id === current;
          const summary = stage.skipped ? "Skipped · gates warn, never block" : s.summary;
          return (
            <div key={stage.id} className="v12-rail-row" data-current={here || undefined} data-state={state} data-insert={over === index && dragging !== stage.id ? "" : undefined}
              draggable={!readOnly && renaming !== stage.id}
              onDragStart={(e) => { setDragging(stage.id); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("application/x-particl-stage", stage.id); } catch { /* read-only */ } }}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(index); } }}
              onDragLeave={() => setOver((o) => (o === index ? null : o))}
              onDrop={(e) => drop(e, index)} onDragEnd={() => { setDragging(null); setOver(null); }}
              data-testid="v12-stage-row" data-stage={stage.id}>
              <Tooltip name={stage.label} line={summary} shortcut={index < 9 ? String(index + 1) : undefined} side="right">
                <button type="button" className="v12-rail-btn" aria-current={here ? "step" : undefined} onClick={() => onPick(stage.id)}
                  aria-label={`${stage.label}${stage.skipped ? " · skipped" : ""} · ${summary}`}>
                  <span className="v12-rail-mark" data-state={state} data-current={here || undefined} aria-hidden="true">
                    {state === "done" ? "✓" : state === "needs" ? String(s.count || 1) : state === "skip" ? "–" : ""}
                  </span>
                  {renaming === stage.id ? null : <span className="v12-rail-label">{stage.label}</span>}
                </button>
              </Tooltip>
              {renaming === stage.id ? (
                <RenameField value={stage.label} onDone={(label) => { setRenaming(null); if (label && label !== stage.label) onEdit({ type: "rename", id: stage.id, label }); }} />
              ) : null}
              {readOnly || renaming === stage.id ? null : (
                <span className="v12-rail-acts">
                  <Tooltip name="Rename">
                    <button type="button" className="v12-rail-act" aria-label={`Rename ${stage.label}`} onClick={() => setRenaming(stage.id)}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 2l3 3-8 8H3v-3z" /></svg>
                    </button>
                  </Tooltip>
                  <Tooltip name="Skip or remove">
                    <button type="button" className="v12-rail-act" aria-label={`${stage.label} menu`} aria-haspopup="menu" aria-expanded={menuFor === stage.id}
                      onClick={(e) => { menuAnchor.current = e.currentTarget; setMenuFor(stage.id); }} data-testid="v12-stage-menu">⋯</button>
                  </Tooltip>
                </span>
              )}
              {menuFor === stage.id ? <Menu open onClose={() => setMenuFor(null)} anchor={menuAnchor} label={stage.label} items={rowMenu(stage, index)} side="right" width={220} /> : null}
            </div>
          );
        })}
        {readOnly ? null : (
          <Tooltip name="Add a stage" side="right">
            <button ref={addAnchor} type="button" className="v12-rail-add" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding(true)} data-testid="v12-stage-add">
              <span className="v12-rail-add-mark" aria-hidden="true">+</span>Stage
            </button>
          </Tooltip>
        )}
        <Menu open={adding} onClose={() => setAdding(false)} anchor={addAnchor} label={currentLabel ? `Add a stage after ${currentLabel}` : "Add a stage"} items={addItems} side="right" width={260} />
      </div>
    </nav>
  );
}

function RenameField({ value, onDone }: { value: string; onDone: (label: string | null) => void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (label: string | null) => { if (done.current) return; done.current = true; onDone(label); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); finish(text.trim() || null); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
  };
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  return (
    <input ref={field} className="v12-rail-rename" aria-label="Stage name" maxLength={40} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => finish(text.trim() || null)} data-testid="v12-stage-rename" />
  );
}
