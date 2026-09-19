import {
  readVideoBytes, readImageBytes, readAudioBytes, readModelBytes, openMediaStream,
  presignedReadUrl, videoPath, imagePath, audioPath, modelPath, usingBlob,
} from "@/lib/storage";
import { CONSUMER_ORIGINAL_MIMES } from "@/lib/higgsfield-consumer/original-identity";
import { getGeneration } from "@/lib/jobs";
import { downloadFilename } from "@/lib/downloadName";
import { requireUser, withTenant } from "@/lib/auth";
import { attachmentDisposition } from "@/lib/contentDisposition";

export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Ctx = { params: Promise<{ id: string }> };

/** Short handle, matching what the UI shows on the clip. */

/**
 * Renders live in private storage and are only ever reachable behind the
 * login. What changes here is HOW the bytes travel.
 *
 * Playback used to read an entire file into this function to answer each
 * request — including the two-byte probe iOS Safari opens every video with.
 * A grid of thumbnails could therefore pull gigabytes through compute and
 * spike memory by the size of whatever was being watched. Now we check the
 * caller, then hand them a short-lived signed link and get out of the way:
 * the bytes stream from storage's own CDN, which serves Range properly
 * (verified in production: `206 bytes 0-1/10, accept-ranges: bytes`).
 *
 * Downloads still come through us, because a cross-origin redirect ignores
 * the `download` attribute and would lose the filename — but they stream
 * rather than buffer, so nothing is ever held whole in memory.
 */
export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;

  const gen = await getGeneration(id).catch(() => null);
  if (!gen || gen.status !== "succeeded") return new Response("Not found", { status: 404 });
  const kind: "video" | "image" | "audio" | "model" =
    gen?.kind === "image" ? "image" : gen?.kind === "audio" ? "audio" : gen?.kind === "model" ? "model" : "video";
  const isImage = kind === "image";
  const isAudio = kind === "audio";
  const isModel = kind === "model";
  // A connected-account original keeps the type the provider served (JPEG,
  // WAV, zip …); the server-written receipt is the only source of that value.
  const originalMime = typeof gen.params.consumerOriginalMime === "string" && CONSUMER_ORIGINAL_MIMES[kind].includes(gen.params.consumerOriginalMime)
    ? gen.params.consumerOriginalMime : null;
  const contentType = originalMime ?? (isImage ? "image/png" : isAudio ? "audio/mpeg" : isModel ? "model/gltf-binary" : "video/mp4");
  const ext = contentType === "application/zip" ? "zip" : contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp"
    : /wav/.test(contentType) ? "wav" : contentType === "audio/ogg" ? "ogg" : contentType === "audio/flac" ? "flac" : contentType === "audio/mp4" || contentType === "audio/aac" ? "m4a"
    : isImage ? "png" : isAudio ? "mp3" : isModel ? "glb" : "mp4";
  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";

  if (wantsDownload) {
    try {
      const stream = await openMediaStream(id, kind);
      // The platform names the file, never the API (R9).
      const filename = await downloadFilename(id, ext);
      return new Response(stream, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": attachmentDisposition(filename),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  /* Poster capture (?stream=1): the wall draws one frame of each render to
     a canvas, and a canvas will only read pixels from the page's own origin.
     So for that one request the bytes pass through here, Range and all —
     a few hundred kilobytes for the header and the first frame, never the
     whole file — instead of redirecting to storage's own domain. */
  const wantsStream = new URL(req.url).searchParams.get("stream") === "1";

  if (usingBlob()) {
    try {
      const signed = await presignedReadUrl(isImage ? imagePath(id) : isAudio ? audioPath(id) : isModel ? modelPath(id) : videoPath(id), 6);
      if (wantsStream) {
        const range = req.headers.get("range");
        const upstream = await fetch(signed, {
          headers: range ? { Range: range } : {},
          cache: "no-store",
        });
        const headers = new Headers({ "Cache-Control": "private, no-store" });
        for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
          const v = upstream.headers.get(h);
          if (v) headers.set(h, v);
        }
        if (!headers.has("content-type")) headers.set("content-type", contentType);
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: signed,
          // The redirect must never outlive the signature it points at, so it
          // is re-authorised on every playback rather than cached.
          "Cache-Control": "private, no-store",
        },
      });
    } catch {
      // Fall through to serving the bytes ourselves rather than failing.
    }
  }

  /* Local development (and the belt-and-braces path in production): serve the
     bytes directly, Range and all. */
  let buf: Buffer;
  try {
    buf = isImage ? await readImageBytes(id) : isAudio ? await readAudioBytes(id) : isModel ? await readModelBytes(id) : await readVideoBytes(id);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const common = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // private: a shared cache must never hold a signed-in user's media
    "Cache-Control": "private, no-store",
  };

  const range = req.headers.get("range");
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] !== "" || m[2] !== "")) {
    let start: number, end: number;
    if (m[1] === "") {
      // suffix form: bytes=-N (last N bytes)
      const n = Math.min(Number(m[2]), buf.length);
      start = buf.length - n;
      end = buf.length - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    }
    if (start > end || start >= buf.length) {
      return new Response(null, {
        status: 416,
        headers: { ...common, "Content-Range": `bytes */${buf.length}` },
      });
    }
    const slice = buf.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        ...common,
        "Content-Length": String(slice.length),
        "Content-Range": `bytes ${start}-${end}/${buf.length}`,
      },
    });
  }

  return new Response(new Uint8Array(buf), {
    headers: { ...common, "Content-Length": String(buf.length) },
  });
});
