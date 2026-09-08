/**
 * What a person hands the agent.
 *
 * Two things happen to an attachment: the agent looks at it — a still goes
 * to the model as an image, so the words it writes are about the thing in
 * front of it — and it is carried forward, so a render the agent proposes
 * uses the same file as its reference rather than a description of it.
 * Pure; the screen uploads, the turn sends, the step carries.
 */
export type Attachment = { uploadId: string; kind: "image" | "video"; name: string; mime: string };

export const MAX_ATTACHMENTS = 4;
/** What a model can be shown. A clip is carried forward but never sent to be read. */
export const seenByModel = (a: Attachment): boolean => a.kind === "image";

export function cleanAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  for (const raw of v.slice(0, MAX_ATTACHMENTS)) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const uploadId = typeof a.uploadId === "string" ? a.uploadId.trim() : "";
    if (!uploadId || !/^[A-Za-z0-9_-]+$/.test(uploadId) || out.some((o) => o.uploadId === uploadId)) continue;
    out.push({
      uploadId,
      kind: a.kind === "video" ? "video" : "image",
      name: typeof a.name === "string" ? a.name.slice(0, 120) : "",
      mime: typeof a.mime === "string" ? a.mime.slice(0, 80) : "image/png",
    });
  }
  return out;
}

/** How the attachments read to the model beside the words, so it knows what it is being shown. */
export function attachmentLine(list: Attachment[]): string {
  if (!list.length) return "";
  const seen = list.filter(seenByModel);
  const carried = list.filter((a) => !seenByModel(a));
  const parts: string[] = [];
  if (seen.length) parts.push(`${seen.length} still${seen.length === 1 ? "" : "s"} attached and shown to you below`);
  if (carried.length) parts.push(`${carried.length} clip${carried.length === 1 ? "" : "s"} attached, which you cannot watch — take them as given`);
  return `ATTACHED: ${parts.join("; ")}. Any render you propose for these should cite them: put "attachments": true on the step.`;
}

/** The references a proposed step carries, when the step asked for them. */
export function stepReferences(list: Attachment[], wants: unknown): { uploadId: string; role: "reference_image" | "reference_video" }[] {
  if (wants !== true) return [];
  return list.map((a) => ({ uploadId: a.uploadId, role: a.kind === "video" ? "reference_video" as const : "reference_image" as const }));
}
