"use client";
import { useRef, useState } from "react";
import { Menu, Tooltip, type MenuItem } from "@/components/v12/ui";

/**
 * The stage header (docs/redesign/inventory.md § 6.4; prototype L270–L272): 44 px; breadcrumbs board › stage ›
 * selection, the stage's meta line where there is room, then at most one filled primary, only on the stage where its
 * action lives, and ⋯ (Board menu). `primary` is null on every other stage: what needs a person elsewhere shows in
 * the rail's markers.
 */
export function StageHeader({ board, stage, meta, selection, primary, menu, onBoard, onStage }: {
  board: string;
  stage: string | null;
  meta: string | null;
  selection: string | null;
  primary: { label: string; run: () => void } | null;
  /** Null: no board menu (a board not started yet). */
  menu: readonly MenuItem[] | null;
  /** The board name: back to the first stage. */
  onBoard?: () => void;
  /** The stage name: clears the selection. */
  onStage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="v12-stagehead" data-testid="v12-stage-header">
      <span className="v12-stagehead-left">
        <span className="v12-crumbs">
          {onBoard ? <button type="button" className="v12-crumb v12-crumb-board" onClick={onBoard} title="The first stage">{board}</button> : <span className="v12-crumb v12-crumb-board" data-testid="v12-board-crumb">{board}</span>}
          {stage ? <><span className="v12-crumb-sep" aria-hidden="true">›</span><button type="button" className="v12-crumb v12-crumb-stage" onClick={onStage} data-testid="v12-stage-crumb">{stage}</button></> : null}
          {selection ? <><span className="v12-crumb-sep" aria-hidden="true">›</span><span className="v12-crumb v12-crumb-stage" data-testid="v12-selection-crumb">{selection}</span></> : null}
        </span>
        {meta ? <span className="v12-stagehead-meta" data-testid="v12-stage-meta">{meta}</span> : null}
      </span>
      <span className="v12-stagehead-right">
        {primary ? <button type="button" className="v12-primary" onClick={primary.run} data-testid="v12-stage-primary">{primary.label}</button> : null}
        {menu ? <><Tooltip name="Board menu">
          <button ref={anchor} type="button" className="v12-stagehead-menu" aria-label="Board menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="v12-board-menu">⋯</button>
        </Tooltip>
        <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Board menu" items={menu} align="start" width={240} /></> : null}
      </span>
    </div>
  );
}
