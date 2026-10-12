import type { Row } from "@libsql/client";
import type { UploadedFile } from "./uploadClient";
import { db, ready } from "./db";
import { assetCursor, assetPageQuery } from "./assetPagination";
import { currentViewer, openableAmong, type Viewer } from "./uploadAccess";

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
    kind: row.kind === "image" || row.kind === "video" || row.kind === "audio" ? row.kind : "file",
    durationS: row.duration_s == null ? null : Number(row.duration_s),
    sha256: String(row.sha256 ?? ""),
    url: `/api/uploads/${encodeURIComponent(String(row.id))}`,
    createdAt: Number(row.created_at),
    ...(row.project_filed===undefined?{}:{projectFiled:Boolean(row.project_filed)}),
  };
}

/** db() is selected by the authenticated tenant, so another workspace's originals stay private. Inside one, the list shows what `viewer` (default: the signed-in person) may open
 * (lib/uploadAccess.ts): their own uploads, unowned older ones, and what shared work uses; a teammate's unattached upload is not listed, not even its name.
 * One set-based check per page of rows; a page that comes back short because of it is topped up from the next rows, a few rounds at most. */
export async function listLibraryUploads(params: URLSearchParams, project?: { productionProjectId: string; uploadIds: string[] }, only?: { id: string }, viewer: Viewer | null = currentViewer()) {
  const { limit, search } = assetPageQuery(params, 200);
  await ready();
  const page = async (from: ReturnType<typeof assetPageQuery>["cursor"]) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    /* One upload by id (a deep link's lookup), still inside the project's own membership below. */
    if (only) {
      where.push("id = ?");
      args.push(only.id);
    }
    if (project) {
      where.push(`(id IN (SELECT value FROM json_each(?)) OR id IN (SELECT upload_id FROM project_library_uploads WHERE project_id=?)
        OR id IN (SELECT j.atom FROM generations g,json_tree(g.params) j WHERE g.project_id=? AND g.deleted=0 AND j.key IN ('uploadId','sourceUploadId','coverUploadId')))`);
      args.push(JSON.stringify(project.uploadIds), project.productionProjectId, project.productionProjectId);
    }
    if (search) {
      where.push("LOWER(filename) LIKE ? ESCAPE '\\'");
      args.push(`%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (from) {
      where.push("(created_at, id) < (?, ?)");
      args.push(from.createdAt, from.id);
    }
    return (await db().execute({
      sql: `SELECT ${columns}${project?', EXISTS(SELECT 1 FROM project_library_uploads f WHERE f.project_id=? AND f.upload_id=uploads.id) AS project_filed':''} FROM uploads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [...(project?[project.productionProjectId]:[]),...args, limit + 1],
    })).rows;
  };
  let cursor = assetPageQuery(params, 200).cursor;
  const accepted: Row[] = [];
  let more = false;
  let scannedLast: Row | undefined;
  for (let round = 0; round < 8; round++) {
    const rows = await page(cursor);
    more = rows.length > limit;
    const scanned = rows.slice(0, limit);
    if (!scanned.length) break;
    /* No viewer: background work for the workspace itself (it has no person to hide anything from). */
    const open = viewer ? await openableAmong(scanned.map((r) => String(r.id)), viewer) : new Set(scanned.map((r) => String(r.id)));
    accepted.push(...scanned.filter((r) => open.has(String(r.id))));
    scannedLast = scanned.at(-1);
    if (accepted.length >= limit || !more) break;
    cursor = { createdAt: Number(scannedLast!.created_at), id: String(scannedLast!.id) };
  }
  const uploads = accepted.slice(0, limit).map(uploadMetadata);
  const last = uploads.at(-1);
  const hasMore = accepted.length > limit || more;
  const from = accepted.length >= limit && last ? { createdAt: last.createdAt, id: last.id } : scannedLast ? { createdAt: Number(scannedLast.created_at), id: String(scannedLast.id) } : null;
  return { uploads, nextCursor: hasMore && from ? assetCursor(from) : null };
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
