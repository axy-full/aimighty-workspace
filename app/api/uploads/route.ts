import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { identifyImage, validateImage } from "@/lib/imagemeta";
import { storeUpload } from "@/lib/storage";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Accepts one image and stores it BYTE-FOR-BYTE.
 *
 * There is no compression step anywhere in this path: the request body is read
 * as raw bytes, written unchanged, then re-read from storage and hashed. The
 * response carries that hash so the client can compare it against its own —
 * if the two match, the stored file is provably identical to the file picked.
 */
export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Attach a file field" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const meta = identifyImage(buf);
  if (!meta) {
    return NextResponse.json(
      { error: "Unrecognised image. ModelArk accepts jpeg, png, webp, bmp, tiff, gif, heic, heif." },
      { status: 400 }
    );
  }

  const problem = validateImage(meta, buf.length);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const uploadId = id("img");
  const { url, sha256 } = await storeUpload(uploadId, meta.ext, buf, meta.mime);

  await db().execute({
    sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uploadId, file.name.slice(0, 200), meta.mime, meta.ext, buf.length,
           sha256, meta.width, meta.height, url, now()],
  });

  return NextResponse.json({
    id: uploadId,
    filename: file.name,
    mime: meta.mime,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    sha256,
    url: `/api/uploads/${uploadId}`,
    // base64 inflates by 4/3 — the client uses this to police the 64MB body cap.
    base64Bytes: Math.ceil(buf.length / 3) * 4,
  });
}
