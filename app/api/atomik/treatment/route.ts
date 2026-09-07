import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { getTreatment, upsertTreatment, listTreatmentVersions, getTreatmentVersion, type Scene, type Note } from "@/lib/atomikDocs";
import { listCast } from "@/lib/cast";

export const dynamic = "force-dynamic";

/** The production's treatment, with the cast it can cite and what is trained. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  await ready();
  const versionWanted = Number(new URL(req.url).searchParams.get("version") ?? NaN);
  const [treatment, cast, versions, snapshot] = await Promise.all([
    getTreatment(projectId), listCast(projectId), listTreatmentVersions(projectId),
    Number.isInteger(versionWanted) && versionWanted > 0 ? getTreatmentVersion(projectId, versionWanted) : Promise.resolve(null),
  ]);
  const ids = await db().execute({ sql: `SELECT name, status FROM identities WHERE project_id = ? OR project_id IS NULL`, args: [projectId] });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const identities = (ids.rows as any[]).map((r) => ({ name: String(r.name), status: String(r.status) }));
  return NextResponse.json({ treatment, cast, identities, versions, snapshot });
});

/** Save the whole document. `bump` starts a new draft number. */
export const PUT = withTenant(async function PUT(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const projectId = body.projectId ? String(body.projectId) : "";
  if (!projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  const scenes: Scene[] = Array.isArray(body.scenes) ? body.scenes : [];
  const notes: Note[] = Array.isArray(body.notes) ? body.notes : [];
  const treatment = await upsertTreatment({
    projectId, ideaId: body.ideaId ? String(body.ideaId) : null,
    title: String(body.title ?? ""), logline: String(body.logline ?? ""),
    setup: body.setup && typeof body.setup === "object" ? body.setup : {},
    scenes, notes, updatedBy: got.user.name, bump: Boolean(body.bump),
  });
  return NextResponse.json({ treatment });
});
