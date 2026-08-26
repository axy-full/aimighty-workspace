import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { identifyImage, validateImage } from "@/lib/imagemeta";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Records an image the browser uploaded directly to Blob storage.
 *
 * Verification is unchanged and, if anything, stronger: we read back exactly
 * what the store holds and hash THAT, so the sha256 returned to the browser
 * proves the stored object matches the file the user picked.
 */
export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const body = await req.json().catch(() => ({}));
  const url = String(body.url ?? "");
  const filename = String(body.filename ?? "image").slice(0, 200);

  if (!/^https:\/\/[\w.-]+\.blob\.vercel-storage\.com\//.test(url)) {
    return NextResponse.json({ error: "Not a valid upload URL" }, { status: 400 });
  }

  let buf: Buffer;
  try {
    const { get } = await import("@vercel/blob");
    const found = await get(url, { access: "private" });
    if (!found?.stream) throw new Error("not found");
    const chunks: Uint8Array[] = [];
    // @ts-expect-error - web stream is async-iterable at runtime
    for await (const c of found.stream) chunks.push(c as Uint8Array);
    buf = Buffer.concat(chunks);
  } catch {
    return NextResponse.json({ error: "Could not read the uploaded file" }, { status: 400 });
  }

  const meta = identifyImage(buf);
  const problem = meta ? validateImage(meta, buf.length) : null;
  if (!meta || problem) {
    // Don't leave a rejected file sitting in storage.
    try {
      const { del } = await import("@vercel/blob");
      await del(url);
    } catch { /* orphan cleanup is best-effort */ }
    return NextResponse.json(
      { error: problem ?? "Unrecognised image. ModelArk accepts jpeg, png, webp, bmp, tiff, gif, heic, heif." },
      { status: 400 }
    );
  }

  const uploadId = id("img");
  const sha256 = createHash("sha256").update(buf).digest("hex");

  await db().execute({
    sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uploadId, filename, meta.mime, meta.ext, buf.length, sha256,
           meta.width, meta.height, url, now()],
  });

  return NextResponse.json({
    id: uploadId, filename, mime: meta.mime, bytes: buf.length,
    width: meta.width, height: meta.height, sha256,
    url: `/api/uploads/${uploadId}`,
    base64Bytes: Math.ceil(buf.length / 3) * 4,
  });
}
