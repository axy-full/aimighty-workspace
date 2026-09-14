import { mediaMutation, validateMediaSources } from "@/lib/mediaMutation";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { listCast, nameProblem, rowToCast } from "@/lib/cast";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const cast = await listCast(projectId && projectId !== "all" && projectId !== "unfiled" ? projectId : null);
  return NextResponse.json({ cast });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const scopeProblem = workbenchScopeProblem(
    req,
    requireTenant().id,
    got.user.id,
  );
  if (scopeProblem)
    return NextResponse.json({ error: scopeProblem }, { status: 409 });
  await ready();
  const body = await req.json().catch(() => ({}));

  const name = String(body.name ?? "").trim();
  const problem = nameProblem(name);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const projectId =
    body.projectId && body.projectId !== "all" && body.projectId !== "unfiled"
      ? String(body.projectId)
      : null;

  const result = await mediaMutation(async (tx) => {
    // Two @Mayas in one project would make a citation ambiguous.
    const clash = await tx.execute({
      sql: `SELECT id FROM cast_members
            WHERE LOWER(name) = ? AND (project_id IS ? OR project_id IS NULL) LIMIT 1`,
      args: [name.toLowerCase(), projectId],
    });
    if (clash.rows.length) {
      return NextResponse.json(
        { error: `@${name} is already cast here.` },
        { status: 409 },
      );
    }

    const cid = id("cast");
    await validateMediaSources(tx, {
      uploadId: body.uploadId ? String(body.uploadId) : null,
    });
    await tx.execute({
      sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
      args: [
        cid,
        projectId,
        name,
        ["character", "location", "prop", "style"].includes(body.kind)
          ? body.kind
          : "character",
        String(body.description ?? "").slice(0, 600),
        body.uploadId ? String(body.uploadId) : null,
        got.user.id,
        now(),
      ],
    });

    return cid;
  });
  if (result instanceof Response) return result;
  const cid = result;
  const rs = await db().execute({
    sql: `SELECT * FROM cast_members WHERE id = ?`,
    args: [cid],
  });
  return NextResponse.json({ member: rowToCast(rs.rows[0]) });
});
