"use client";
import type { LibraryEntry } from "@/lib/workspace/library";
import { ViralHistory } from "../../viral/ViralView";
import type { BoardCtx } from "../cards/types";

/*
 * The Social board's History drawer: today's History view (every Motion transfer and Object swap take in the project, with
 * Recreate, Compare, Send to Edit, Download, and Cancel while a take still waits), in the board's drawer. Free to read.
 */
export function SocialHistoryDrawer({ ctx, items, onClose }: { ctx: BoardCtx; items: readonly LibraryEntry[]; onClose: () => void }) {
  return (
    <aside className="bd-drawer sb-history" aria-label="History" data-testid="board-history">
      <div className="bd-drawer-head">
        <strong>History</strong>
        <button type="button" className="bd-drawer-close" aria-label="Close History" onClick={onClose}>×</button>
      </div>
      <div className="sb-history-body nowheel">
        <ViralHistory scope={ctx.scope} project={ctx.project} items={[...items]} />
      </div>
    </aside>
  );
}
