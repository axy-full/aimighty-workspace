import { readVideoBytes, readImageBytes } from "@/lib/storage";
import { getGeneration } from "@/lib/jobs";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

/**
 * Serves renders from private storage — behind the login in every environment.
 * The generation row says whether the media is a video or a still.
 *
 * Honors HTTP Range requests: Safari (iOS especially) probes with
 * `Range: bytes=0-1` and refuses to play <video> from a server that answers
 * 200 without range semantics, and seeking anywhere needs 206 responses.
 * For a film team reviewing on phones, that's the primary path.
 */
export async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;

  const gen = await getGeneration(id).catch(() => null);
  const isImage = gen?.kind === "image";

  let buf: Buffer;
  try {
    buf = isImage ? await readImageBytes(id) : await readVideoBytes(id);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const common = {
    "Content-Type": isImage ? "image/png" : "video/mp4",
    "Accept-Ranges": "bytes",
    // private: a shared cache must never hold a signed-in user's media
    "Cache-Control": "private, max-age=31536000, immutable",
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
}
