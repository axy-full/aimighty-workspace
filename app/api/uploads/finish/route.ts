import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { identifyImage, validateImage, validateVideo } from "@/lib/imagemeta";
import { assembleChunks, deleteChunks, storeUpload } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  if (!SESSION.test(session) || !Number.isInteger(count) || count < 1 || count > 100) {
    return NextResponse.json({ error: "Bad finish request" }, { status: 400 });
  }

  const scoped = `${got.user.id}/${session}`;
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
