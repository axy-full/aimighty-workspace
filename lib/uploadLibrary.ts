import type { Row } from "@libsql/client";
import type { UploadedFile } from "./uploadClient";
import { db, ready } from "./db";
import { assetCursor, assetPageQuery } from "./assetPagination";

export type LibraryUpload = UploadedFile & { createdAt: number };

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
  };
}

/** db() is selected by the authenticated tenant, so all studio members see
 * their workspace's uploads while another workspace's originals stay private. */
export async function listLibraryUploads(params: URLSearchParams) {
  const { limit, search, cursor } = assetPageQuery(params, 200);
  await ready();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (search) {
    where.push("LOWER(filename) LIKE ? ESCAPE '\\'");
    args.push(`%${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (cursor) {
    where.push("(created_at, id) < (?, ?)");
    args.push(cursor.createdAt, cursor.id);
  }
  const result = await db().execute({
    sql: `SELECT ${columns} FROM uploads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [...args, limit + 1],
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
