import { NextResponse } from "next/server";
import { getGeneration, syncGeneration } from "@/lib/jobs";
import { db, ready } from "@/lib/db";
import { deleteVideo } from "@/lib/storage";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ generation: await syncGeneration(gen) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.projectId !== undefined) {
    await db().execute({
      sql: `UPDATE generations SET project_id=?, updated_at=? WHERE id=?`,
      args: [body.projectId || null, Date.now(), id],
    });
  }
  return NextResponse.json({ ok: true });
}

/**
 * "Delete" removes the video file and hides the clip, but the row survives
 * with its cost — money already spent must never vanish from the ledger.
 * Hard-deleting rows made "remaining credit" drift optimistic with every
 * library cleanup.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await deleteVideo(id);
  await db().execute({
    sql: `UPDATE generations SET deleted=1, stored_url=NULL, source_url=NULL, updated_at=? WHERE id=?`,
    args: [Date.now(), id],
  });
  return NextResponse.json({ ok: true });
}
