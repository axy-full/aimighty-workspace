import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { nameProblem, rowToCast } from "@/lib/cast";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (body.name != null) {
    const problem = nameProblem(String(body.name));
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  }

  await db().execute({
    sql: `UPDATE cast_members
          SET name = COALESCE(?, name),
              description = COALESCE(?, description),
              kind = COALESCE(?, kind),
              upload_id = COALESCE(?, upload_id)
          WHERE id = ?`,
    args: [
      body.name == null ? null : String(body.name).trim(),
      body.description == null ? null : String(body.description).slice(0, 600),
      ["character", "location", "style"].includes(body.kind) ? body.kind : null,
      body.uploadId == null ? null : String(body.uploadId),
      id,
    ],
  });
  const rs = await db().execute({ sql: `SELECT * FROM cast_members WHERE id = ?`, args: [id] });
  if (!rs.rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ member: rowToCast(rs.rows[0]) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await db().execute({ sql: `DELETE FROM cast_members WHERE id = ?`, args: [id] });
  return NextResponse.json({ ok: true });
}
