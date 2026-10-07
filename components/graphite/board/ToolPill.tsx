"use client";
import { useStore } from "@xyflow/react";
import { PILL_LABELS_FROM } from "@/lib/board/geometry";
import { Glyph } from "./Rail";

/*
 * The board's bottom tool pill (README § 1.1, § 6; the master's board): Select (V), Frame (F), Note (N), Text (T),
 * Image (I), Video (⇧V), Audio (⇧A), Upload (U). Labels go under a 660 px canvas. Note and Text place a card where
 * the canvas is pressed next; Image, Video and Audio open Make on that type; Upload adds files to the Library.
 * Frame needs card groups the board does not have yet (S1), so it says so instead of pretending.
 */
export type BoardTool = "select" | "frame" | "note" | "text" | "image" | "video" | "audio" | "upload";

export const TOOLS: { id: BoardTool; label: string; keys: string; icon: string }[] = [
  { id: "select", label: "Select", keys: "V", icon: "M3 2l10 6-4.5 1.5L7 14z" },
  { id: "frame", label: "Frame", keys: "F", icon: "M2 4h12v8H2zM5 2v2M11 2v2" },
  { id: "note", label: "Note", keys: "N", icon: "M3 2h10v9l-3 3H3zM10 14v-3h3" },
  { id: "text", label: "Text", keys: "T", icon: "M3 3h10M8 3v10M6 13h4" },
  { id: "image", label: "Image", keys: "I", icon: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3" },
  { id: "video", label: "Video", keys: "⇧V", icon: "M2 4h8v8H2zM10 7l4-2v6l-4-2" },
  { id: "audio", label: "Audio", keys: "⇧A", icon: "M3 6v4h3l4 3V3L6 6zM12 6a3 3 0 0 1 0 4" },
  { id: "upload", label: "Upload", keys: "U", icon: "M8 11V3M4 7l4-4 4 4M3 13h10" },
];
const WHY_NOT: Partial<Record<BoardTool, string>> = { frame: "Frames need card groups, which the board does not have yet." };

export function ToolPill({ tool, readOnly, onTool }: { tool: BoardTool; readOnly: boolean; onTool: (tool: BoardTool) => void }) {
  const width = useStore((s) => s.width);
  const labels = width === 0 || width >= PILL_LABELS_FROM;
  return (
    <div className="bd-pill" role="toolbar" aria-label="Board tools" data-testid="board-tools" data-labels={labels || undefined}>
      {TOOLS.map((item) => {
        const why = WHY_NOT[item.id] ?? (readOnly && item.id !== "select" ? "Needs a connection" : null);
        return (
          <button key={item.id} type="button" className="bd-tool" aria-pressed={tool === item.id} aria-label={`${item.label} (${item.keys})`}
            title={why ?? `${item.label} · ${item.keys}`} aria-disabled={why ? true : undefined} data-tool={item.id}
            onClick={() => { if (!why) onTool(item.id); }}>
            <Glyph d={item.icon} />
            {labels ? <span>{item.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
