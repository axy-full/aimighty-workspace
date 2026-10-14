import { projectExists, projectLister, reachableOr } from "@/lib/draftProject";
import { mediaMutation, validateMediaSources } from "@/lib/mediaMutation";
import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { castNameClash, listCast, nameProblem, rowToCast } from "@/lib/cast";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const asked = new URL(req.url).searchParams.get("projectId");
  /* A private board's cast is its owner's alone, and a shared board's is for looking at (lib/draftProject.ts): a list of one reads as an unknown project's, and the list of every cast leaves them out. */
  const named = asked && asked !== "all" && asked !== "unfiled" ? await reachableOr(got.user, asked, "read") : null;
  /* An admin of this workspace who asks for one board's cast gets it (owner, 13 Oct), through the gate that writes the history line; the list of every cast is not widened. */
  const listed = await projectLister(got.user, undefined, { only: named });
  const cast = (await listCast(named)).filter((c) => listed(c.projectId));
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
      ? await reachableOr(got.user, String(body.projectId), "write")
      : null;
  /* Asked before anything is written: a board that is not theirs and one that does not exist get the same answer. */
  if (projectId !== null && !(await projectExists(projectId))) return NextResponse.json({ error: "No such project." }, { status: 404 });

  const result = await mediaMutation(async (tx) => {
    // Two @Mayas a production can see would make a citation ambiguous.
    if (await castNameClash(tx, name, projectId)) {
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
