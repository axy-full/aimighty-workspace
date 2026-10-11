"use client";
import { useEffect, useRef } from "react";
import { closeEditSound, useEditSoundOpen } from "../cards/cut/edit-sound";
import { typingIn } from "../review/review-model";
import { EditSoundScreen } from "../edit/EditSoundScreen";
import type { BoardCtx } from "../cards/types";

/*
 * Open Edit & Sound (README § 3.1 frame i; Gaps A "Edit & Sound"): the editor full screen over the board, under the header,
 * with Close (board/edit/EditSoundScreen.tsx). It reads and saves the project's own draft through the same draft editor the old
 * page (components/workspace/pages/EditPage.tsx, still the old shell's) uses. Esc closes it, never while typing.
 */
export function EditSoundHost({ ctx }: { ctx: BoardCtx }) {
  const open = useEditSoundOpen();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !typingIn(e.target)) { e.preventDefault(); closeEditSound(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div ref={box} className="gx-edit-host" role="dialog" aria-modal="true" aria-label="Edit & Sound" tabIndex={-1} data-testid="edit-sound">
      <EditSoundScreen ctx={ctx} onClose={closeEditSound} />
    </div>
  );
}
