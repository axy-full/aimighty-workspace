import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { CATEGORIES } from "@/lib/studio";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const scope = (v: string | null) => (v && v !== "all" && v !== "unfiled" ? v : null);

/** Presets belong to a project, or to the whole workspace when made from
 *  "All projects" — the same rule the cast follows. */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const projectId = scope(new URL(req.url).searchParams.get("projectId"));
  const rs = projectId
    ? await db().execute({
        sql: `SELECT * FROM shot_presets WHERE project_id = ? OR project_id IS NULL ORDER BY created_at`,
        args: [projectId],
      })
    : await db().execute(`SELECT * FROM shot_presets WHERE project_id IS NULL ORDER BY created_at`);
  return NextResponse.json({
    presets: rs.rows.map((r: any) => ({
      id: r.id, name: r.name, projectId: r.project_id ?? null,
      spec: JSON.parse(r.spec || "{}"), createdAt: Number(r.created_at),
    })),
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Give the look a name." }, { status: 400 });
  if (name.length > 60) return NextResponse.json({ error: "That name is too long." }, { status: 400 });

  // Only keys and values the taxonomy actually knows — a preset that names a
  // category we removed would silently contribute nothing to a prompt.
  const raw = (body.spec ?? {}) as Record<string, unknown>;
  const spec: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    const v = raw[cat.key];
    if (typeof v === "string" && cat.options.some((o) => o.value === v)) spec[cat.key] = v;
  }
  if (!Object.keys(spec).length) {
    return NextResponse.json({ error: "Set at least one control before saving a look." }, { status: 400 });
  }

  const projectId = scope(body.projectId ? String(body.projectId) : null);
  const clash = await db().execute({
    sql: `SELECT id FROM shot_presets WHERE LOWER(name) = ? AND (project_id IS ?) LIMIT 1`,
    args: [name.toLowerCase(), projectId],
  });
  if (clash.rows.length) {
    return NextResponse.json({ error: `"${name}" already exists here.` }, { status: 409 });
  }

  const pid = id("prst");
  await db().execute({
    sql: `INSERT INTO shot_presets (id, project_id, name, spec, created_by, created_at)
          VALUES (?,?,?,?,?,?)`,
    args: [pid, projectId, name, JSON.stringify(spec), got.user.id, now()],
  });
  return NextResponse.json({ id: pid, name, spec });
}
