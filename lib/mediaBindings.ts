import type { Transaction } from "@libsql/client";

export class MediaSourceError extends Error {}

/** Collect persisted media identities across versions, lineage and shared context. */
export function referencedMedia(value: unknown): {
  uploads: Set<string>;
  generations: Set<string>;
} {
  const uploads = new Set<string>(),
    generations = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      const match = item.match(
        /^\/api\/(uploads|media)\/([^/?#]+)(?:[?#].*)?$/,
      );
      if (match) {
        try {
          const id = decodeURIComponent(match[2]);
          if (/^[A-Za-z0-9_-]+$/.test(id))
            (match[1] === "uploads" ? uploads : generations).add(id);
        } catch {
          /* A malformed URL cannot identify a stored object. */
        }
      }
    } else if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === "object") {
      const object = item as Record<string, unknown>;
      for (const key of ["uploadId", "sourceUploadId", "coverUploadId"])
        if (typeof object[key] === "string") uploads.add(object[key] as string);
      for (const key of ["generationId", "genId", "sourceGenId", "coverGenId"])
        if (typeof object[key] === "string")
          generations.add(object[key] as string);
      pending.push(...Object.values(object));
    }
  }
  return { uploads, generations };
}

/** Call inside the same write transaction that removes the media identity. Never disclose private draft names. */
export async function mediaBindingProblem(
  tx: Transaction,
  kind: "upload" | "generation",
  id: string,
): Promise<string | null> {
  const directSql =
    kind === "upload"
      ? [
          "SELECT 1 FROM attribute_versions WHERE upload_id=?",
          "SELECT 1 FROM identities WHERE cover_upload_id=?",
          "SELECT 1 FROM cast_members WHERE upload_id=?",
          "SELECT 1 FROM messages WHERE upload_id=?",
          "SELECT 1 FROM shot_presets WHERE cover_upload_id=?",
        ]
      : [
          "SELECT 1 FROM attribute_versions WHERE gen_id=?",
          "SELECT 1 FROM elements WHERE from_gen_id=?",
          "SELECT 1 FROM atomik_steps WHERE gen_id=?",
          "SELECT 1 FROM shot_presets WHERE cover_gen_id=?",
          "SELECT 1 FROM generations WHERE source_gen_id=? AND deleted=0",
        ];
  if (
    (
      await tx.execute({
        sql: directSql.join(" UNION ALL ") + " LIMIT 1",
        args: directSql.map(() => id),
      })
    ).rows.length
  )
    return "This media is used by a catalog version, identity, cast member, chat or another take. Remove those references before deleting it.";
  const rows = (
    await tx.execute({
      sql: `SELECT body,'normal' AS shape FROM workbench_projects
    UNION ALL SELECT body,'normal' FROM workbench_bibles
    UNION ALL SELECT photos,'photos' FROM identities
    UNION ALL SELECT nodes,'normal' FROM boards
    UNION ALL SELECT params,'normal' FROM generations WHERE deleted=0 AND id<>?
    UNION ALL SELECT refs,'normal' FROM shot_presets
    UNION ALL SELECT setup,'normal' FROM shots
    UNION ALL SELECT attachments,'normal' FROM atomik_messages WHERE attachments IS NOT NULL
    UNION ALL SELECT refs,'normal' FROM atomik_steps WHERE refs IS NOT NULL
    UNION ALL SELECT params,'normal' FROM atomik_steps WHERE params IS NOT NULL`,
      args: [id],
    })
  ).rows;
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(String(row.body || "[]"));
      if (row.shape === "photos" && Array.isArray(value))
        value = value.map((uploadId) => ({ uploadId }));
    } catch {
      return "A production record could not be checked. Keep this media until the record is repaired.";
    }
    const references = referencedMedia(value);
    if (
      (kind === "upload" ? references.uploads : references.generations).has(id)
    )
      return "This media is used by a production draft or published shared context. Remove draft references first; published source media must be kept.";
  }
  if (kind === "generation") {
    const mapped = (
      await tx.execute({
        sql: `SELECT 1 FROM generations g JOIN workbench_shots s ON s.shot_id=g.shot_id
      JOIN workbench_projects p ON p.owner=s.owner AND p.project_id=s.draft_id WHERE g.id=? LIMIT 1`,
        args: [id],
      })
    ).rows.length;
    if (mapped)
      return "This take belongs to a production node. Keep its history while that production draft exists.";
  }
  return null;
}
