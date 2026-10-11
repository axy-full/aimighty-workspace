import { db } from "../db";
import { readUploadBytes } from "../storage";
import { IMAGE_MIMES, MAX_SOURCE_BYTES, normalize } from "./atomik-references";
import { projectLibraryReady } from "./project-library";
import type { SnapshotAttachment } from "./rig-agent-plan";
import { PLANNER_ATTACHMENTS, PLANNER_TEXT_CHARS, type PlannerAttachmentContent } from "./rig-agent-planner";

/*
 * The files a person attached to an ask for a board (the empty board's Attach): checked, then handed to the
 * planning turn the way Atomik is handed references elsewhere (lib/workbench/atomik-references.ts) — an image as
 * a bounded 512 px review copy, a text file as an excerpt, anything else by name.
 *
 * Tenancy: an id is looked up in the caller's own workspace database (db() is the tenant's), and only among the
 * uploads filed in this production's Library (project_library_uploads). An id from another workspace, another
 * project, or none at all is the same refusal, and no storage is read for it.
 */

/** How the board names an attached file: an upload of the person's (`upload:<id>`). */
export const ATTACHMENT_ID = /^upload:([A-Za-z0-9_-]{1,160})$/;
/** The longest text file Atomik reads for a plan (the Atomik references' cap). */
export const TEXT_MAX_BYTES = 100_000;

export class PlanAttachmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "PlanAttachmentError"; }
}

/** An attached file as checked: what the planner is told it is, and where its bytes are (server-only). */
export type PlanAttachment = SnapshotAttachment & { uploadId: string; mime: string; ext: string; storedUrl: string; bytes: number };

const kindOf = (mime: string): SnapshotAttachment["kind"] => (IMAGE_MIMES.has(mime) ? "image" : mime === "text/plain" ? "text" : "file");

/**
 * Checks the ids an ask names against this production's Library in the caller's workspace, in the order given.
 * Refuses (400) more than Atomik takes at once, an id that is not an upload's, one named twice, one not filed in
 * this production, an image over 32 MB and a text file over 100 KB. Reads no file.
 */
export async function resolvePlanAttachments(productionId: string, ids: readonly unknown[] | null | undefined): Promise<PlanAttachment[]> {
  const list = ids ?? [];
  if (!list.length) return [];
  if (list.length > PLANNER_ATTACHMENTS) throw new PlanAttachmentError(`Atomik reads at most ${PLANNER_ATTACHMENTS} attached files for a plan. Take some out and press Start again.`);
  const uploadIds = list.map((id) => (typeof id === "string" ? ATTACHMENT_ID.exec(id)?.[1] : undefined));
  if (uploadIds.some((id) => !id)) throw new PlanAttachmentError("An attached file isn't one Atomik can read. Attach it again.");
  if (new Set(uploadIds).size !== uploadIds.length) throw new PlanAttachmentError("Attach each file once.");
  await projectLibraryReady();
  const rows = (await db().execute({
    sql: `SELECT u.id, u.filename, u.mime, u.ext, u.bytes, u.stored_url FROM uploads u
          JOIN project_library_uploads p ON p.upload_id = u.id
          WHERE p.project_id = ? AND u.id IN (${uploadIds.map(() => "?").join(",")})`,
    args: [productionId, ...(uploadIds as string[])],
  })).rows;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return (uploadIds as string[]).map((uploadId) => {
    const row = byId.get(uploadId);
    if (!row) throw new PlanAttachmentError("An attached file isn't in this project's Library. Attach it again.");
    const mime = String(row.mime).toLowerCase(), bytes = Number(row.bytes), name = String(row.filename || "Attached file");
    const kind = kindOf(mime);
    if (kind === "image" && !(bytes <= MAX_SOURCE_BYTES)) throw new PlanAttachmentError(`${name} is over 32 MB. Attach a smaller copy for Atomik to look at.`);
    if (kind === "text" && !(bytes <= TEXT_MAX_BYTES)) throw new PlanAttachmentError(`${name} is over 100 KB. Attach a shorter text file, or put an excerpt in the box.`);
    return { id: `upload:${uploadId}`, uploadId, name, kind, mime, ext: String(row.ext), storedUrl: String(row.stored_url), bytes };
  });
}

/** What the planner is told of each file (no storage address; a text file's size, which bounds its excerpt): the snapshot's list. */
export const attachedOf = (list: readonly PlanAttachment[]): SnapshotAttachment[] => list.map(({ id, name, kind, bytes }) => ({ id, name, kind, ...(kind === "text" ? { bytes } : {}) }));

export type AttachmentReaders = { upload: typeof readUploadBytes };

/**
 * Reads what the planner is shown of the checked files: each image as Atomik's bounded review copy, each text file's
 * excerpt. A named file is not read. A file that can't be read or decoded is refused (422) before anything is reserved.
 */
export async function loadPlanAttachmentContent(list: readonly PlanAttachment[], readers: AttachmentReaders = { upload: readUploadBytes }): Promise<PlannerAttachmentContent> {
  const content: PlannerAttachmentContent = { images: [], texts: [] };
  for (const a of list) {
    if (a.kind === "file") continue;
    let bytes: Buffer;
    try { bytes = await readers.upload(a.uploadId, a.ext, a.storedUrl); }
    catch { throw new PlanAttachmentError(`${a.name} could not be read for Atomik. Attach it again.`, 422); }
    if (a.kind === "text") {
      if (bytes.length > TEXT_MAX_BYTES) throw new PlanAttachmentError(`${a.name} is over 100 KB. Attach a shorter text file, or put an excerpt in the box.`);
      /* Its size is what its excerpt was priced at: a stored copy longer than the Library says is not sent. */
      if (bytes.length > a.bytes) throw new PlanAttachmentError(`${a.name} changed since it was attached. Attach it again.`, 422);
      content.texts.push({ id: a.id, text: bytes.toString("utf8").slice(0, PLANNER_TEXT_CHARS) });
      continue;
    }
    if (bytes.length > MAX_SOURCE_BYTES) throw new PlanAttachmentError(`${a.name} is over 32 MB. Attach a smaller copy for Atomik to look at.`);
    try { content.images.push({ id: a.id, dataUrl: (await normalize(bytes, { id: a.id, name: a.name })).dataUrl }); }
    catch { throw new PlanAttachmentError(`${a.name} could not be read as a picture. Attach a PNG, JPEG or WebP copy.`, 422); }
  }
  return content;
}
