import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { identifyImage, validateVideo } from "@/lib/imagemeta";
import { getProvider, DEFAULT_PROVIDER } from "@/lib/providers";
import { assess, deriveForProvider } from "@/lib/derive";
import { getSetting } from "@/lib/settings";
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
    const provider = getProvider(DEFAULT_PROVIDER);
    if (meta.kind === "video") {
      const problem = validateVideo(meta, buf.length);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }

    /* R4 — same contract as the direct route: the master is kept exactly as
     * it arrived, and anything the vendor won't take travels as a derived
     * delivery copy instead. This is the path big files actually use, so it
     * is the path where the guarantee matters most. */
    const verdict = meta.kind === "image"
      ? assess(meta, buf.length, provider)
      : { ok: true, reasons: [] as string[], derivable: false };
    const mayDerive = (await getSetting("deriveForApi")) !== "0";

    if (!verdict.ok && (!verdict.derivable || !mayDerive)) {
      return NextResponse.json({
        error: `This asset can't be sent to ${provider.label}: ${verdict.reasons.join("; ")}.` +
               (verdict.derivable
                 ? " Delivery copies are switched off in Settings, so it was not stored."
                 : " Nothing was compressed — send a larger original."),
      }, { status: 400 });
    }

    const uploadId = id(meta.kind === "video" ? "vid" : "img");
    const { url, sha256 } = await storeUpload(uploadId, meta.ext, buf, meta.mime);

    let derivativeUrl: string | null = null;
    let derivativeBytes: number | null = null;
    let derivativeNote: string | null = null;
    if (!verdict.ok && verdict.derivable && mayDerive) {
      try {
        const d = await deriveForProvider(buf, provider);
        const stored = await storeUpload(`${uploadId}-api`, d.ext, d.bytes, d.mime);
        derivativeUrl = stored.url;
        derivativeBytes = d.bytes.length;
        derivativeNote = d.note;
      } catch (e) {
        return NextResponse.json({
          error: `${provider.label} won't accept this asset and a delivery copy could not be made: ` +
                 `${(e as Error).message}`,
        }, { status: 400 });
      }
    }

    await db().execute({
      sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, kind, duration_s, created_at,
                                 derivative_url, derivative_bytes, derivative_note)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [uploadId, filename, meta.mime, meta.ext, buf.length, sha256,
             meta.width, meta.height, url, meta.kind, meta.durationS, now(),
             derivativeUrl, derivativeBytes, derivativeNote],
    });

    // Belt and braces: the response hash is of what the STORE holds.
    const check = createHash("sha256").update(buf).digest("hex");
    return NextResponse.json({
      id: uploadId, filename, mime: meta.mime, kind: meta.kind,
      bytes: buf.length, width: meta.width, height: meta.height,
      durationS: meta.durationS, sha256: check,
      url: `/api/uploads/${uploadId}`,
      delivery: derivativeNote ? { note: derivativeNote, bytes: derivativeBytes } : null,
      base64Bytes: meta.kind === "video" ? 0 : Math.ceil(buf.length / 3) * 4,
    });
  } finally {
    await deleteChunks(scoped, count);
  }
}
