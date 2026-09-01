import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { identifyImage, validateVideo } from "@/lib/imagemeta";
import { storeUpload } from "@/lib/storage";
import { requireUser } from "@/lib/auth";
import { getProvider, DEFAULT_PROVIDER } from "@/lib/providers";
import { assess, deriveForProvider } from "@/lib/derive";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Accepts one image and stores it BYTE-FOR-BYTE.
 *
 * There is no compression step anywhere in this path: the request body is read
 * as raw bytes, written unchanged, then re-read from storage and hashed. The
 * response carries that hash so the client can compare it against its own —
 * if the two match, the stored file is provably identical to the file picked.
 *
 * R4: a master that a downstream API won't accept is no longer refused. The
 * master is kept exactly as it arrived, and a separate DELIVERY COPY is
 * derived to fit the vendor's limits — so a 30 MB ceiling at ByteDance can't
 * decide what resolution this studio is allowed to keep. The copy is never
 * shown in the library, downloaded, or exported; it exists only to be sent.
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
      { error: "Unrecognised file. Images: jpeg/png/webp/bmp/tiff/gif/heic. Videos: mp4/mov." },
      { status: 400 }
    );
  }

  const provider = getProvider(DEFAULT_PROVIDER);

  if (meta.kind === "video") {
    const problem = validateVideo(meta, buf.length);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  /* Images are judged against the provider BEFORE anything is written, so a
   * file we can neither send nor fix doesn't leave an orphan in storage.
   * "Too small" is the one failure a derivative can't honestly fix —
   * upscaling invents detail — so it is still refused, with the reason. */
  let verdict = meta.kind === "image"
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

  /* The delivery copy. Derived from the master in memory, stored beside it,
   * and recorded — the master on disk is never read back through a codec. */
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
    verdict = { ok: true, reasons: verdict.reasons, derivable: true };
  }

  await db().execute({
    sql: `INSERT INTO uploads (id, filename, mime, ext, bytes, sha256, width, height, stored_url, kind, duration_s, created_at,
                               derivative_url, derivative_bytes, derivative_note)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [uploadId, file.name.slice(0, 200), meta.mime, meta.ext, buf.length,
           sha256, meta.width, meta.height, url, meta.kind, meta.durationS, now(),
           derivativeUrl, derivativeBytes, derivativeNote],
  });

  return NextResponse.json({
    id: uploadId,
    filename: file.name,
    mime: meta.mime,
    kind: meta.kind,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    durationS: meta.durationS,
    sha256,
    url: `/api/uploads/${uploadId}`,
    // Present only when the master was too big/odd for the vendor. The
    // library and every download still serve the master.
    delivery: derivativeNote
      ? { note: derivativeNote, bytes: derivativeBytes }
      : null,
    // base64 inflates by 4/3 — images may inline as base64 in local dev.
    base64Bytes: meta.kind === "video" ? 0 : Math.ceil(buf.length / 3) * 4,
  });
}
