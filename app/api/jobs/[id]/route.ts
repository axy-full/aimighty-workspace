import { NextResponse } from "next/server";
import { getGeneration, syncGeneration } from "@/lib/jobs";
import { db, ready } from "@/lib/db";
import { deleteVideo } from "@/lib/storage";
import { requireUser } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

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
  // A name for the render. Empty clears it — the clip id comes back.
  if (body.title !== undefined) {
    const title = String(body.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    await db().execute({
      sql: `UPDATE generations SET title=?, updated_at=? WHERE id=?`,
      args: [title || null, Date.now(), id],
    });
  }
  // Signing off on a shot, or asking for changes. The name is recorded so a
  // review is answerable to someone rather than appearing from nowhere.
  if (body.reviewState !== undefined) {
    const state = ["approved", "changes", ""].includes(String(body.reviewState))
      ? String(body.reviewState) : "";
    await db().execute({
      sql: `UPDATE generations SET review_state=?, review_by=?, reviewed_at=?, updated_at=? WHERE id=?`,
      args: [state, state ? got.user.name : null, state ? Date.now() : null, Date.now(), id],
    });
  }
  invalidate(PROJECTS_KEY);
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
  /* The row first, the bytes second. If the order were reversed and the
     UPDATE then failed, the render would still be listed as delivered with
     its file already gone — a permanently broken tile with no repair path.
     An orphaned blob is only storage, and the reverse is unrecoverable. */
  await db().execute({
    sql: `UPDATE generations SET deleted=1, stored_url=NULL, source_url=NULL, updated_at=? WHERE id=?`,
    args: [Date.now(), id],
  });
  await deleteVideo(id);
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
}
