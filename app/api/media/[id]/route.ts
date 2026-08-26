import { readVideoBytes } from "@/lib/storage";
import { requireUser } from "@/lib/auth";

type Ctx = { params: Promise<{ id: string }> };

/** Serves renders from private storage — behind the login in every environment. */
export async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  try {
    const buf = await readVideoBytes(id);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buf.length),
        // private: a shared cache must never hold a signed-in user's video
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
