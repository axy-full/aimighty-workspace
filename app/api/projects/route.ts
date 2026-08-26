import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const rs = await db().execute(`
    SELECT p.*,
           (SELECT COUNT(*) FROM generations g WHERE g.project_id = p.id AND g.deleted=0) AS gen_count,
           (SELECT COALESCE(SUM(g.cost_usd),0) FROM generations g WHERE g.project_id = p.id) AS spend
    FROM projects p ORDER BY p.created_at DESC
  `);
  return NextResponse.json({
    /* eslint-disable @typescript-eslint/no-explicit-any */
    projects: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: Number(r.created_at),
      genCount: Number(r.gen_count),
      spend: Number(r.spend),
    })),
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const pid = id("prj");
  await db().execute({
    sql: `INSERT INTO projects (id, name, description, created_at) VALUES (?,?,?,?)`,
    args: [pid, name.slice(0, 120), String(body.description ?? "").slice(0, 500), now()],
  });
  return NextResponse.json({ id: pid, name });
}
