import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { cached, putCache, invalidate, PROJECTS_KEY } from "@/lib/cache";

export const dynamic = "force-dynamic";

/* This is polled app-wide every 30s, so it must not cost more as the library
   grows. Two correlated subqueries PER PROJECT became one grouped pass over
   generations, memoised briefly so several open tabs share a single read.
   Counts still exclude deleted clips while spend still includes them — the
   ledger records money spent, not files kept. */
const TTL_MS = 15_000;

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const hit = cached<unknown>(PROJECTS_KEY, TTL_MS);
  if (hit) return NextResponse.json(hit);

  const rs = await db().execute(`
    SELECT p.*,
           COALESCE(g.n, 0)     AS gen_count,
           COALESCE(g.spend, 0) AS spend
    FROM projects p
    LEFT JOIN (
      SELECT project_id,
             SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS n,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)), 0) AS spend
      FROM generations GROUP BY project_id
    ) g ON g.project_id = p.id
    ORDER BY p.created_at DESC
  `);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const body = {
    projects: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code ?? "",
      description: r.description,
      createdAt: Number(r.created_at),
      genCount: Number(r.gen_count),
      spend: Number(r.spend),
    })),
  };
  putCache(PROJECTS_KEY, body);
  return NextResponse.json(body);
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
    sql: `INSERT INTO projects (id, name, description, created_at, code) VALUES (?,?,?,?,?)`,
    args: [pid, name.slice(0, 120), String(body.description ?? "").slice(0, 500), now(),
           // A short code is what makes {projectcode} usable in a filename.
           String(body.code ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16)],
  });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ id: pid, name });
}
