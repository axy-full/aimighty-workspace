import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { identifyImage, validateImage, validateVideo } from "@/lib/imagemeta";
import { assembleChunks, deleteChunks, storeUpload, streamAssembleUpload } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const SESSION = /^[a-f0-9-]{16,64}$/;

/**
 * Reassembles a chunked upload into ONE private object.
 *
 * The chunks are concatenated exactly as received — no decode, no re-encode —
 * and the sha256 of the assembled file is returned so the browser can prove
 * the stored object matches the file that was picked.
 */
export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const body = await req.json().catch(() => ({}));
  const session = String(body.session ?? "");
  const count = Number(body.count);
  const filename = String(body.filename ?? "upload").slice(0, 200);
  const purpose = body.purpose === "chat" ? "chat" : "reference";

  if (!SESSION.test(session) || !Number.isInteger(count) || count < 1 || count > 600) {
    return NextResponse.json({ error: "Bad finish request" }, { status: 400 });
  }

  const scoped = `${got.user.id}/${session}`;

  /* ── Chat attachments: any file type, streamed — never buffered whole ── */
  if (purpose === "chat") {
    const safeExt = (filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "bin").toLowerCase();
    const clientMime = String(body.mime ?? "");
    const mime = /^[\w.-]+\/[\w.+-]+$/.test(clientMime) ? clientMime : "application/octet-stream";
    const uploadId = id("file");
    try {
      const { sha256, bytes, headChunk } = await streamAssembleUpload(
        scoped, count, uploadId, safeExt, mime
      );
      if (bytes > 2 * 1024 * 1024 * 1024) {
        return NextResponse.json({ error: "Chat files top out at 2 GB." }, { status: 400 });
      }
      // Identify from the head so images/videos preview nicely; anything else
      // is simply a file. (mp4s with the index at the tail read as duration
      // unknown — chat doesn't need it.)
      const meta = identifyImage(headChunk);
      const kind = meta?.kind ?? "file";
      await db().execute({
        sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, kind, duration_s, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [uploadId, filename, mime, safeExt, bytes, sha256,
               meta?.width ?? null, meta?.height ?? null,
               `/api/uploads/${uploadId}`, kind, meta?.durationS ?? null, now()],
      });
      return NextResponse.json({
        id: uploadId, filename, mime, kind, bytes, sha256,
        url: `/api/uploads/${uploadId}`,
      });
    } catch (e) {
      console.error("chat assemble failed:", (e as Error).message);
      return NextResponse.json({ error: "A chunk went missing — try the upload again." }, { status: 400 });
    } finally {
      await deleteChunks(scoped, count);
    }
  }

  let buf: Buffer;
  try {
    buf = await assembleChunks(scoped, count);
  } catch {
    return NextResponse.json({ error: "A chunk went missing — try the upload again." }, { status: 400 });
  }

  try {
    const meta = identifyImage(buf);
    if (!meta) {
      return NextResponse.json(
        { error: "Unrecognised file. Images: jpeg/png/webp/bmp/tiff/gif/heic. Videos: mp4/mov." },
        { status: 400 }
      );
    }
    const problem = meta.kind === "video"
      ? validateVideo(meta, buf.length)
      : validateImage(meta, buf.length);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const uploadId = id(meta.kind === "video" ? "vid" : "img");
    const { url, sha256 } = await storeUpload(uploadId, meta.ext, buf, meta.mime);

    await db().execute({
      sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, kind, duration_s, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [uploadId, filename, meta.mime, meta.ext, buf.length, sha256,
             meta.width, meta.height, url, meta.kind, meta.durationS, now()],
    });

    // Belt and braces: the response hash is of what the STORE holds.
    const check = createHash("sha256").update(buf).digest("hex");
    return NextResponse.json({
      id: uploadId, filename, mime: meta.mime, kind: meta.kind,
      bytes: buf.length, width: meta.width, height: meta.height,
      durationS: meta.durationS, sha256: check,
      url: `/api/uploads/${uploadId}`,
      base64Bytes: meta.kind === "video" ? 0 : Math.ceil(buf.length / 3) * 4,
    });
  } finally {
    await deleteChunks(scoped, count);
  }
}
