"use client";
import { useRef, useState } from "react";
import { ID_TYPE, readDrop } from "@/lib/drop";
import { DRAG_TYPE } from "@/lib/dnd";
import type { UploadedFile } from "@/lib/uploadClient";
import { uploadFilesToProject } from "@/lib/workspace/library";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import type { Asset } from "@/lib/workbench/studio";

/** What a prompt box was given: Library ids, the new uploads among them, and notes to show. */
export type Attached = { ids: string[]; uploads: UploadedFile[]; notes: string[] };

export const ATTACH_ACCEPT = "image/*,video/*,audio/*,application/pdf,text/plain,.fountain,.fdx,.txt,.md";

/**
 * Every prompt box takes media from the device (owner, 25 September: "all
 * forms of media uploads from device in every prompt box should be allowed").
 * Wrap the box: an Attach button (pictures, video, sound, PDFs, text), files
 * pasted into it, and files or Library tiles dropped on it. Files go into the
 * project's Library first (lib/workspace/library uploadFilesToProject), then
 * the box's own `onAttach` puts each where its engine takes it — a reference,
 * a shot input, a drawing — and says in `onAttach`'s answer what it did with
 * anything its engine cannot take (it stays in the Library either way).
 */
export function PromptAttach({ scope, projectId, onAttach, children, label = "Attach", accept = ATTACH_ACCEPT, testId = "prompt-attach", className = "" }: {
  scope: string; projectId: string | null | undefined;
  /** Place the attachments; answer a sentence about anything not used here (null when all were used). */
  onAttach: (attached: Attached) => string | null | void | Promise<string | null | void>;
  children: React.ReactNode; label?: string; accept?: string; testId?: string; className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const take = async (ids: string[], files: File[]) => {
    if (!ids.length && !files.length) return;
    setNote(null);
    try {
      let uploads: UploadedFile[] = [], notes: string[] = [];
      if (files.length) {
        if (!projectId) throw new Error("Open a project first; attachments are kept in its Library.");
        setBusy(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
        ({ uploads, notes } = await uploadFilesToProject(scope, projectId, files));
      }
      const said = await onAttach({ ids: [...ids, ...uploads.map((u) => `upload:${u.id}`)], uploads, notes });
      const text = [...notes, ...(said ? [said] : [])].join(" ");
      setNote(text || null);
    } catch (error) { setNote(error instanceof Error ? error.message : "The files could not be attached."); }
    finally { setBusy(null); }
  };
  const ours = (types: readonly string[]) => types.includes("Files") || types.includes(ID_TYPE) || types.includes(DRAG_TYPE);

  return (
    <div className={`pa-wrap ${className}`} data-testid={testId} data-drop={over || undefined}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        void take([], files);
      }}
      onDragOver={(e) => { if (ours(Array.from(e.dataTransfer.types))) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        setOver(false);
        if (!ours(Array.from(e.dataTransfer.types))) return;
        e.preventDefault(); e.stopPropagation();
        const { ids, files } = readDrop(e.dataTransfer);
        void take(ids, files);
      }}>
      {children}
      <div className="pa-bar">
        <button type="button" className="pa-btn" onClick={() => input.current?.click()} disabled={Boolean(busy)} data-testid={`${testId}-button`} aria-label={`${label}: pictures, video, sound or documents from this device`}>
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M12 6.5l-5.3 5.3a3.2 3.2 0 01-4.5-4.5L7.8 1.7a2.1 2.1 0 013 3L5.2 10.3a1 1 0 01-1.5-1.5L8.6 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{busy ?? label}</span>
        </button>
        <span className="pa-hint">or paste / drop files</span>
        <input ref={input} type="file" multiple hidden accept={accept} data-testid={`${testId}-file`}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void take([], files); }} />
      </div>
      {note ? <p className="pa-note" role="status" data-testid={`${testId}-note`}>{note}</p> : null}
    </div>
  );
}

/** Every attached id resolved to its media in this workspace (server-verified, lib/genAssetInput), in order; those that cannot be read are named. */
export async function resolveAttached(scope: string, attached: Attached): Promise<{ media: GenInputAsset[]; unreadable: string[] }> {
  const media: GenInputAsset[] = [], unreadable: string[] = [];
  for (const id of attached.ids) {
    try { media.push(await resolveGenInput(id, scope)); }
    catch {
      /* A document (a PDF, a script, a text file) is not a picture or a take; it is still in the Library. */
      const upload = attached.uploads.find((u) => `upload:${u.id}` === id);
      unreadable.push(upload?.filename ?? id);
    }
  }
  return { media, unreadable };
}

/** An attachment as a project asset, to file on the project and use as an input or a reference. */
export function attachedAsset(m: GenInputAsset, category: string, description: string): Asset {
  return {
    id: m.id, ...(m.origin === "generation" ? { generationId: m.id } : { uploadId: m.id }),
    kind: m.kind === "file" ? "document" : m.kind, category, name: m.name.slice(0, 200), url: m.url, mime: m.mime,
    description: description.slice(0, 500), prompt: "", status: "Draft", locked: false, version: 1, refs: [],
  } as Asset;
}

/** The sentence for what a box could not use: kept in the Library, and why. */
export function keptNote(names: string[], why: string): string | null {
  if (!names.length) return null;
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} kept in the Library — ${why}`;
}
