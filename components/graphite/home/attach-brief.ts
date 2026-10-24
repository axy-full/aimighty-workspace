/**
 * Attach a brief on Home, upload first (owner, 24 Oct 2026, item 6: any brief up to the upload cap lands and is read).
 * The file goes up to the workspace's Library before anything else, through the chunked upload (a "chat" upload, so up to
 * MAX_CHAT_BYTES), and only then is read on this device into the box. A file the reader here cannot take (over 20 MB or
 * 400 pages, scanned, no text) is still in the Library, and the person is told so; it is read once document reading ships.
 * Start files the stored upload into the project it makes (StoredFile, lib/workspace/library.ts) and never uploads it twice.
 *
 * The upload and the reader are handed in, so this file imports neither: it stays free of the upload client for the
 * guest's box, which shares Home's components. Uploads are free: nothing here prices or charges anything.
 */
import { BRIEF } from "@/lib/copy";
import { uploadCapProblem } from "@/lib/uploadCaps";
import type { UploadedFile } from "@/lib/uploadClient";
import type { StoredFile } from "@/lib/workspace/library";
import { BriefFileError, briefKind, briefReadable } from "./brief-file";

/** A brief the person attached, with its upload's receipt once it is stored (null: not up yet, Start uploads it). */
export type AttachedBrief = { file: File; upload: UploadedFile | null };

export type BriefOutcome = {
  upload: UploadedFile;
  /** The words read into the box, or null when the reader here could not read the file. */
  text: string | null;
  cut: boolean;
  /** What to tell the person when nothing was read: the file is in the Library and is read later. */
  note: string | null;
};

export async function attachBrief(file: File, steps: {
  /** The chunked upload (the hook's: uploadFile(file, "chat", …) in the workspace's scope). */
  save: (file: File, onProgress: (pct: number) => void) => Promise<UploadedFile>;
  /** The reader on this device (readBriefFile). */
  read: (file: File, signal: AbortSignal, onPage?: (page: number, total: number) => void) => Promise<{ text: string; cut: boolean }>;
  signal: AbortSignal;
  onProgress?: (pct: number) => void;
  /** The file is in the Library; reading starts. */
  onSaved?: () => void;
  onPage?: (page: number, total: number) => void;
}): Promise<BriefOutcome> {
  if (!briefKind(file)) throw new BriefFileError("Use a PDF or text file.");
  /* Over the upload cap: refused now, naming the cap, before a byte is hashed or sent. */
  const problem = uploadCapProblem(file, "chat");
  if (problem) throw new BriefFileError(problem);
  const upload = await steps.save(file, (pct) => steps.onProgress?.(pct));
  steps.onSaved?.();
  const unread = { upload, text: null, cut: false, note: BRIEF.savedUnread };
  if (steps.signal.aborted) throw new BriefFileError("Reading stopped.");
  if (!briefReadable(file)) return unread;
  try {
    const read = await steps.read(file, steps.signal, steps.onPage);
    return { upload, text: read.text, cut: read.cut, note: null };
  } catch (error) {
    if (steps.signal.aborted) throw error;
    return unread;
  }
}

/** What Start files into the project it makes: the brief already stored is filed as it is; one not up yet is uploaded with the references. */
export function startFiles(brief: AttachedBrief | null, refs: readonly File[]): (File | StoredFile)[] {
  if (!brief) return [...refs];
  return [brief.upload ? { file: brief.file, stored: brief.upload } : brief.file, ...refs];
}
