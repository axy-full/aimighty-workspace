import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { listIdeas, createIdea } from "@/lib/atomikDocs";

export const dynamic = "force-dynamic";

/** Every idea, with the production it became (if it did) and how far that got. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const ideas = await listIdeas();
  await ready();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rs = await db().execute(`
    SELECT p.id, p.name, (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shots FROM projects p`);
  const projects = new Map((rs.rows as any[]).map((r) => [String(r.id), { name: String(r.name), shots: Number(r.shots ?? 0) }]));
  const users = await db().execute(`SELECT id, name FROM users`);
  const names = new Map((users.rows as any[]).map((r) => [String(r.id), String(r.name)]));
  return NextResponse.json({
    ideas: ideas.map((i) => ({
      ...i,
      projectName: i.projectId ? projects.get(i.projectId)?.name ?? null : null,
      shots: i.projectId ? projects.get(i.projectId)?.shots ?? 0 : 0,
      byName: names.get(i.createdBy) ?? null,
      parkedByName: i.parkedBy ? names.get(i.parkedBy) ?? null : null,
    })),
  });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const logline = String(body.logline ?? "").trim();
  if (!logline) return NextResponse.json({ error: "Write the logline first." }, { status: 400 });
  const tone = Array.isArray(body.tone) ? body.tone.map((t: unknown) => String(t).trim().slice(0, 30)).filter(Boolean) : [];
  const refs = Array.isArray(body.refs) ? body.refs.map(String).slice(0, 3) : [];
  const idea = await createIdea({ logline, tone, refs, createdBy: got.user.id });
  return NextResponse.json({ idea });
});
