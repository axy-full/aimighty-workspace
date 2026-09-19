import type { Transaction } from "@libsql/client";
import { requireTenant } from "./tenant";

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
  if ((await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='higgsfield_consumer_jobs'")).rows.length) {
    const jobs=(await tx.execute({sql:"SELECT payload_json FROM higgsfield_consumer_jobs WHERE workflow='genjutsu' AND (status IN ('dispatching','accepted','uncertain') OR (status='quoted' AND quote_expires_at>?))",args:[Date.now()]})).rows;
    for(const job of jobs){
      try{const refs=referencedMedia(JSON.parse(String(job.payload_json)));if((kind==="upload"?refs.uploads:refs.generations).has(id))return "This original is retained by an active quote or job. Finish or let the quote expire before deleting it.";}
      catch{return "An active connected-account source record could not be checked. Keep this original until recovery completes.";}
    }
  }
  if ((await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='higgsfield_consumer_media_imports'")).rows.length &&
      (await tx.execute({sql:"SELECT 1 FROM higgsfield_consumer_media_imports WHERE source_identity=? AND created_at>? LIMIT 1",args:[`${kind}:${id}`,Date.now()-180_000]})).rows.length)
    return "This original is being transferred for a quote. Try again after the transfer finishes.";
  if ((await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='astra_render_jobs'")).rows.length) {
    const jobs=(await tx.execute("SELECT source_json FROM astra_render_jobs WHERE settled=0")).rows;
    for(const job of jobs){const refs=referencedMedia(JSON.parse(String(job.source_json)));if((kind==='upload'?refs.uploads:refs.generations).has(id))return 'This original is retained by a native 3D render. Finish or cancel the render before deleting it.';}
  }
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
  if (kind === 'upload' && (await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_library_uploads'")).rows.length &&
    (await tx.execute({sql:'SELECT 1 FROM project_library_uploads WHERE upload_id=? LIMIT 1',args:[id]})).rows.length)
    return 'This original is filed in a project library. Remove its project filing before deleting it.';
  if ((await tx.execute({sql:'SELECT 1 FROM workbench_edit_sources WHERE kind=? AND source_id=? LIMIT 1',args:[kind,id]})).rows.length)
    return 'This media is retained by an edit version. Keep its original source so earlier cuts remain recoverable.';
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
      return "A project record could not be checked. Keep this media until the record is repaired.";
    }
    const references = referencedMedia(value);
    if (
      (kind === "upload" ? references.uploads : references.generations).has(id)
    )
      return "This media is used by a project draft, retained edit version or published shared context. Remove draft references first; retained source media must be kept.";
  }
  const pipelineProblem = await pipelineMediaBindingProblem(tx, kind, id);
  if (pipelineProblem) return pipelineProblem;
  if ((await tx.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='soul_identities'")).rows.length) {
    const identities = (await tx.execute("SELECT references_json FROM soul_identities")).rows;
    for (const identity of identities) {
      let refs: ReturnType<typeof referencedMedia>;
      try { refs = referencedMedia(JSON.parse(String(identity.references_json))); }
      catch { return "An identity's source history could not be checked. Keep this media until its record is repaired."; }
      if ((kind === "upload" ? refs.uploads : refs.generations).has(id)) return "This portrait is retained by an identity. Keep its original reference and training history.";
    }
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
      return "This take belongs to a project node. Keep its history while that project draft exists.";
  }
  return null;
}

/** Older tenant databases have no pipeline tables. Check on the caller's
 * transaction so a source cannot be detached between this scan and deletion. */
async function pipelineMediaBindingProblem(tx: Transaction, kind: "upload" | "generation", id: string): Promise<string | null> {
  const names = new Set((await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pipeline_%'")).rows.map(row => String(row.name)));
  const workspaceId = requireTenant().id;
  if (kind === "generation" && names.has("pipeline_attempts") && (await tx.execute({
    sql: "SELECT 1 FROM pipeline_attempts WHERE workspace_id=? AND generation_id=? LIMIT 1", args: [workspaceId, id],
  })).rows.length) return "This media belongs to a production pipeline. Keep its inputs and take history.";
  const sources = [
    ["pipeline_versions", "body"], ["pipeline_quotes", "body"], ["pipeline_attempts", "prepared"],
    ["pipeline_selections", "body"], ["pipeline_runs", "assemblies"],
  ] as const;
  for (const [table, column] of sources) {
    if (!names.has(table)) continue;
    const rows = (await tx.execute({ sql: `SELECT ${column} AS body FROM ${table} WHERE workspace_id=?`, args: [workspaceId] })).rows;
    for (const row of rows) {
      let body: unknown;
      try { body = JSON.parse(String(row.body || "{}")); }
      catch { return "A production pipeline could not be checked. Keep this media until its record is repaired."; }
      const refs = referencedMedia(body);
      // Compiled source objects distinguish a generated take from an upload
      // through {source,id}; quoted admissions also carry explicit genId/uploadId.
      const pending: unknown[] = [body];
      while (pending.length) {
        const value = pending.pop();
        if (Array.isArray(value)) pending.push(...value);
        else if (value && typeof value === "object") {
          const item = value as Record<string, unknown>;
          if (typeof item.id === "string") {
            if (item.source === "upload") refs.uploads.add(item.id);
            if (item.source === "generation") refs.generations.add(item.id);
          }
          pending.push(...Object.values(item));
        }
      }
      if ((kind === "upload" ? refs.uploads : refs.generations).has(id))
        return "This media belongs to a production pipeline. Keep its inputs and take history.";
    }
  }
  return null;
}
