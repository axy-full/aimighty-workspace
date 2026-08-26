import { readLocalVideo } from "@/lib/storage";
import { requireUser } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** Serves locally-stored renders in dev. In production Vercel Blob serves directly. */
export async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  try {
    const buf = await readLocalVideo(id);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
