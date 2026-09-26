import { withMediaSources } from "@/lib/mediaMutation";
import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { castNameClash, nameProblem, rowToCast } from "@/lib/cast";
import { archiveAndDelete } from "@/lib/archive";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.name != null) {
    const problem = nameProblem(String(body.name));
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  const renamed = await withMediaSources({ uploadId: body.uploadId == null ? null : String(body.uploadId) }, async (tx) => {
    /* A rename must not make two members answer to one @Name: a citation
       would then resolve to whichever sorted last. */
    if (body.name != null) {
      const row = await tx.execute({ sql: `SELECT project_id FROM cast_members WHERE id = ?`, args: [id] });
      const projectId = row.rows[0] ? ((row.rows[0] as { project_id?: string | null }).project_id ?? null) : null;
      if (row.rows[0] && await castNameClash(tx, String(body.name), projectId, id)) return false;
    }
    await tx.execute({
      sql: `UPDATE cast_members
            SET name = COALESCE(?, name),
                description = COALESCE(?, description),
                kind = COALESCE(?, kind),
                upload_id = COALESCE(?, upload_id)
            WHERE id = ?`,
      args: [
        body.name == null ? null : String(body.name).trim(),
        body.description == null ? null : String(body.description).slice(0, 600),
        // "prop" was added to the cast later and this list was not updated,
        // so a member could never be re-kinded to one.
        ["character", "location", "prop", "style"].includes(body.kind) ? body.kind : null,
        body.uploadId == null ? null : String(body.uploadId),
        id,
      ],
    });
    return true;
  });
  if (!renamed) return NextResponse.json({ error: `@${String(body.name).trim()} is already cast here.` }, { status: 409 });
  const rs = await db().execute({ sql: `SELECT * FROM cast_members WHERE id = ?`, args: [id] });
  if (!rs.rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ member: rowToCast(rs.rows[0]) });
});

export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await archiveAndDelete(db(), "cast_members", `id = ?`, [id]);
  return NextResponse.json({ ok: true });
});
