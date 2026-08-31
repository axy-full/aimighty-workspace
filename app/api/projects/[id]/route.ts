import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  await db().execute({
    sql: `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`,
    args: [body.name ?? null, body.description ?? null, id],
  });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
}

/** Deletes the project but keeps its generations (they fall back to All gens). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await db().execute({ sql: `UPDATE generations SET project_id = NULL WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM projects WHERE id = ?`, args: [id] });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
}
