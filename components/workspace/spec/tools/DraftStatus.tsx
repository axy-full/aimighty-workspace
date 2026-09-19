"use client";
import type { DraftEditor } from "@/lib/workspace/use-draft-editor";

/** Save state for a Studio panel mounted on a spec page; a rejected save offers the saved version. */
export function DraftStatus({ editor, children }: { editor: DraftEditor; children?: React.ReactNode }) {
  return (
    <div className="pxw-draft-status" data-save-state={editor.saveState}>
      <span className="pxw-draft-state" role="status">{editor.saveState}</span>
      {children}
      {editor.error && editor.status === "ready" ? (
        <span className="pxw-draft-error" role="alert">
          {editor.error}{" "}
          <button type="button" className="pxw-link-button" onClick={editor.reload}>Load the saved version</button>
        </span>
      ) : null}
    </div>
  );
}

/** Loading and load-error states shared by the draft-backed tools. */
export function DraftGate({ editor, label }: { editor: DraftEditor; label: string }) {
  if (editor.status === "loading") return <p className="pxw-spec-work-empty" role="status">Opening {label}…</p>;
  return (
    <p className="pxw-spec-work-empty" role="alert">
      {editor.error || "This project could not be opened."}{" "}
      <button type="button" className="pxw-link-button" onClick={editor.reload}>Retry</button>
    </p>
  );
}
