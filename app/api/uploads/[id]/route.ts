import { db, ready } from "@/lib/db";
import { readUploadBytes } from "@/lib/storage";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Serves the original bytes with the original content type. No transform. */
export async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;

  const rs = await db().execute({
    sql: `SELECT mime, ext, stored_url FROM uploads WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = rs.rows[0] as unknown as { mime: string; ext: string; stored_url: string } | undefined;
  if (!row) return new Response("Not found", { status: 404 });

  try {
    const buf = await readUploadBytes(id, row.ext, row.stored_url);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": row.mime,
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await db().execute({ sql: `DELETE FROM uploads WHERE id = ?`, args: [id] });
  return Response.json({ ok: true });
}
