"use client";
import { useEffect, useRef } from "react";
import { EditPage } from "@/components/workspace/pages/EditPage";
import { closeEditSound, useEditSoundOpen } from "../cards/cut/edit-sound";
import { typingIn } from "../review/review-model";
import type { BoardCtx } from "../cards/types";

/*
 * Open Edit & Sound (README § 3.1 frame i; DECISIONS 20): the existing editor (components/workspace/pages/EditPage.tsx)
 * full screen over the board, under the header, with Close. The editor is unchanged: it reads and saves the project's
 * own draft, as it does on its old page. Esc closes it, never while typing.
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
      <div className="gx-edit-top">
        <strong className="gx-edit-title">Edit &amp; Sound</strong>
        <button type="button" className="gx-edit-close" onClick={closeEditSound} data-testid="edit-sound-close">Close</button>
      </div>
      <div className="gx-edit-body gx-scroll">
        <div className="pxw gx-legacy"><div className="pxw-content"><EditPage page="edit" project={ctx.project} scope={ctx.scope} /></div></div>
      </div>
    </div>
  );
}
