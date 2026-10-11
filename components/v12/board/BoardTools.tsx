"use client";
import { useState } from "react";
import { Segment, Tooltip } from "@/components/v12/ui";
import type { TooltipContent } from "@/components/v12/ui";

/**
 * The board's right toolbar (docs/redesign/inventory.md § 6.5; prototype L338): eight 40 px tools, vertically centred at
 * the right, Canvas view only. Their tooltips are § 4.3's; a tool's shortcut is shown only where today's board binds it.
 * What each does is today's (components/graphite/board/ToolPill.tsx): Note and Text place a card; Image, Video and Audio
 * open Make on that kind (placing an empty card comes with the bar); Upload adds files; Frame waits for card groups.
 *
 * First visit: each tool shows its short label, with "Got it". `?first=1` shows them again. The dismissal is kept per
 * person in this browser.
 */
export type ToolId = "select" | "frame" | "note" | "text" | "image" | "video" | "audio" | "upload";
export const BOARD_TOOLS: readonly { id: ToolId; d: string; tip: TooltipContent; short: string }[] = [
  { id: "select", d: "M3 2l5 12 1.5-4.5L14 8z", short: "Select · V", tip: { name: "Select", shortcut: "V", line: "Select, move and resize cards. Hold Space to pan." } },
  { id: "frame", d: "M2 4h12v8H2zM5 2v2M11 2v2", short: "Frame · F", tip: { name: "Frame", line: "Draw a frame to group cards: a scene, a sequence, or options to compare. Not on the board yet: frames need card groups." } },
  { id: "note", d: "M3 2h10v9l-3 3H3zM10 14v-3h3", short: "Note · N", tip: { name: "Note", shortcut: "N", line: "A sticky note for ideas, feedback or to-dos." } },
  { id: "text", d: "M3 3h10M8 3v10M6 13h4", short: "Text · T", tip: { name: "Text", shortcut: "T", line: "A heading or label on the canvas." } },
  { id: "image", d: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3", short: "Image · I", tip: { name: "Image", shortcut: "I", line: "Make a still: opens Make on Image." } },
  { id: "video", d: "M2 4h8v8H2zM10 7l4-2v6l-4-2", short: "Video", tip: { name: "Video", shortcut: "⇧V", line: "Make a clip: opens Make on Video." } },
  { id: "audio", d: "M3 6v4h3l4 3V3L6 6zM12 6a3 3 0 0 1 0 4", short: "Audio", tip: { name: "Audio", shortcut: "⇧A", line: "A voice line, music or a sound effect: opens Make on Audio." } },
  { id: "upload", d: "M8 11V3M4 7l4-4 4 4M3 13h10", short: "Upload · U", tip: { name: "Upload", shortcut: "U", line: "Add your own photos, video or audio." } },
];

const seenKey = (who: string | null) => `particl:v12:board-tools-seen:${who ?? "anyone"}`;
function readSeen(who: string | null): boolean {
  try { return window.localStorage.getItem(seenKey(who)) === "1"; } catch { return false; }
}

export function BoardToolbar({ tool, readOnly, onTool, userId, firstVisit }: {
  tool: ToolId;
  readOnly: boolean;
  onTool: (tool: ToolId) => void;
  userId: string | null;
  /** `?first=1`: the labels show whatever this browser remembers. */
  firstVisit: boolean;
}) {
  const [labels, setLabels] = useState(() => typeof window !== "undefined" && (firstVisit || !readSeen(userId)));
  const gotIt = () => {
    setLabels(false);
    try { window.localStorage.setItem(seenKey(userId), "1"); } catch { /* private window: shown again next time */ }
  };
  return (
    <div className="v12-tools" role="toolbar" aria-orientation="vertical" aria-label="Board tools" data-testid="v12-board-tools" data-labels={labels || undefined}>
      {BOARD_TOOLS.map((t) => {
        const why = t.id === "frame" ? "Not on the board yet" : readOnly && t.id !== "select" ? "Needs a connection" : null;
        return (
          <Tooltip key={t.id} {...t.tip} side="left" disabled={labels}>
            <button type="button" className="v12-tool" aria-pressed={tool === t.id} aria-disabled={why ? true : undefined} aria-label={t.tip.name}
              data-tool={t.id} onClick={() => { if (!why) onTool(t.id); }}>
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.d} /></svg>
              {labels ? <span className="v12-tool-label">{t.short}</span> : null}
            </button>
          </Tooltip>
        );
      })}
      {labels ? <button type="button" className="v12-tools-got" onClick={gotIt} data-testid="v12-tools-got-it">Got it</button> : null}
    </div>
  );
}

/** The view switch (§ 6.5): Canvas, List and Rig are built; Strip is not yet and says so. */
export type BoardViewId = "canvas" | "list" | "strip" | "rig";
export function ViewSwitch({ view, onView }: { view: "canvas" | "list" | "rig"; onView: (view: "canvas" | "list" | "rig") => void }) {
  return (
    <div className="v12-viewswitch" data-testid="v12-view-switch">
      <Segment<BoardViewId> label="View" size="sm" value={view} onChange={(id) => { if (id === "canvas" || id === "list" || id === "rig") onView(id); }} options={[
        { id: "canvas", label: "Canvas", tooltip: { name: "Canvas", line: "Free cards you can move, group and annotate." } },
        { id: "list", label: "List", tooltip: { name: "List", line: "The shot list: #, size, description, VO, duration, status." } },
        { id: "strip", label: "Strip", disabled: true, tooltip: { name: "Strip", line: "Timeline / animatic with durations. Not built yet." } },
        { id: "rig", label: "Rig", tooltip: { name: "Rig", line: "See what feeds what, and what a change will cost." } },
      ]} />
    </div>
  );
}
