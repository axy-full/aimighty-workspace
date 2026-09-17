import type { Row } from "@libsql/client";
import type { UploadedFile } from "./uploadClient";
import { db, ready } from "./db";
import { assetCursor, assetPageQuery } from "./assetPagination";

export type LibraryUpload = UploadedFile & { createdAt: number; projectFiled?: boolean };

// Explicit public metadata only: never SELECT or return a storage URL/key.
const columns = "id, filename, mime, bytes, width, height, kind, duration_s, sha256, created_at";

function uploadMetadata(row: Row): LibraryUpload {
  return {
    id: String(row.id),
    filename: String(row.filename ?? ""),
    mime: String(row.mime ?? ""),
    bytes: Number(row.bytes ?? 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    kind: row.kind === "image" || row.kind === "video" ? row.kind : "file",
    durationS: row.duration_s == null ? null : Number(row.duration_s),
    sha256: String(row.sha256 ?? ""),
    url: `/api/uploads/${encodeURIComponent(String(row.id))}`,
    createdAt: Number(row.created_at),
    ...(row.project_filed===undefined?{}:{projectFiled:Boolean(row.project_filed)}),
  };
}

/** db() is selected by the authenticated tenant, so all studio members see
 * their workspace's uploads while another workspace's originals stay private. */
export async function listLibraryUploads(params: URLSearchParams, project?: { productionProjectId: string; uploadIds: string[] }) {
  const { limit, search, cursor } = assetPageQuery(params, 200);
  await ready();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (project) {
    where.push(`(id IN (SELECT value FROM json_each(?)) OR id IN (SELECT upload_id FROM project_library_uploads WHERE project_id=?)
      OR id IN (SELECT j.atom FROM generations g,json_tree(g.params) j WHERE g.project_id=? AND g.deleted=0 AND j.key IN ('uploadId','sourceUploadId','coverUploadId')))`);
    args.push(JSON.stringify(project.uploadIds), project.productionProjectId, project.productionProjectId);
  }
  if (search) {
    where.push("LOWER(filename) LIKE ? ESCAPE '\\'");
    args.push(`%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (cursor) {
    where.push("(created_at, id) < (?, ?)");
    args.push(cursor.createdAt, cursor.id);
  }
  const result = await db().execute({
    sql: `SELECT ${columns}${project?', EXISTS(SELECT 1 FROM project_library_uploads f WHERE f.project_id=? AND f.upload_id=uploads.id) AS project_filed':''} FROM uploads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [...(project?[project.productionProjectId]:[]),...args, limit + 1],
  });
  const uploads = result.rows.slice(0, limit).map(uploadMetadata);
  const last = uploads.at(-1);
  return {
    uploads,
    nextCursor: result.rows.length > limit && last
      ? assetCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getLibraryUpload(id: string): Promise<LibraryUpload | null> {
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  await ready();
  const result = await db().execute({
    sql: `SELECT ${columns} FROM uploads WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return result.rows[0] ? uploadMetadata(result.rows[0]) : null;
}
