/**
 * What a person hands the agent.
 *
 * Two things happen to an attachment: the agent looks at it — a still goes
 * to the model as an image, so the words it writes are about the thing in
 * front of it — and it is carried forward, so a render the agent proposes
 * uses the same file as its reference rather than a description of it.
 * Pure; the screen uploads, the turn sends, the step carries.
 */
export type Attachment = {
  /** Where it lives: an upload of the person's, or a take the workspace already made. */
  uploadId?: string;
  genId?: string;
  kind: "image" | "video";
  name: string;
  mime: string;
  /** The cast name it stands for, when it came from the cast. */
  cast?: string;
};

/** Every attachment is one thing or the other, never both and never neither. */
export const attachmentId = (a: Attachment): string => a.genId ?? a.uploadId ?? "";

export const MAX_ATTACHMENTS = 4;
/** What a model can be shown. A clip is carried forward but never sent to be read. */
export const seenByModel = (a: Attachment): boolean => a.kind === "image";

export function cleanAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  const ok = (s: unknown): string => (typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s.trim()) ? s.trim() : "");
  for (const raw of v.slice(0, MAX_ATTACHMENTS)) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const uploadId = ok(a.uploadId); const genId = ok(a.genId);
    /* One or the other: a thing the person uploaded, or a take the
       workspace already made. Both at once names nothing. */
    if ((uploadId && genId) || (!uploadId && !genId)) continue;
    const id = genId || uploadId;
    if (out.some((o) => attachmentId(o) === id)) continue;
    out.push({
      ...(uploadId ? { uploadId } : { genId }),
      kind: a.kind === "video" ? "video" : "image",
      name: typeof a.name === "string" ? a.name.slice(0, 120) : "",
      mime: typeof a.mime === "string" ? a.mime.slice(0, 80) : "image/png",
      ...(typeof a.cast === "string" && a.cast.trim() ? { cast: a.cast.trim().slice(0, 60) } : {}),
    });
  }
  return out;
}

/** How the attachments read to the model beside the words, so it knows what it is being shown. */
export function attachmentLine(list: Attachment[]): string {
  if (!list.length) return "";
  const seen = list.filter(seenByModel);
  const carried = list.filter((a) => !seenByModel(a));
  const named = list.filter((a) => a.cast).map((a) => `@${a.cast}`);
  const parts: string[] = [];
  if (seen.length) parts.push(`${seen.length} still${seen.length === 1 ? "" : "s"} attached and shown to you below`);
  if (carried.length) parts.push(`${carried.length} clip${carried.length === 1 ? "" : "s"} attached, which you cannot watch — take them as given`);
  const who = named.length ? ` They are ${named.join(", ")} from the cast, so name them in any prompt.` : "";
  return `ATTACHED: ${parts.join("; ")}.${who} Any render you propose for these should cite them: put "attachments": true on the step.`;
}

/** The references a proposed step carries, when the step asked for them. */
export type StepRef = { uploadId?: string; genId?: string; role: "reference_image" | "reference_video" };

export function stepReferences(list: Attachment[], wants: unknown): StepRef[] {
  if (wants !== true) return [];
  return list.map((a) => ({
    ...(a.genId ? { genId: a.genId } : { uploadId: a.uploadId as string }),
    role: a.kind === "video" ? "reference_video" as const : "reference_image" as const,
  }));
}
