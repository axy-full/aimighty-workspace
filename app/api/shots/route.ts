import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { listShots, createShot, codeProblem } from "@/lib/shots";

export const dynamic = "force-dynamic";

const scope = (v: string | null) =>
  v && v !== "all" && v !== "unfiled" ? v : null;

export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = scope(new URL(req.url).searchParams.get("projectId"));
  const shots = await listShots(projectId);

  // Counts per shot in one pass — the shot list is also the revision report.
  await ready();
  const rs = await db().execute(`
    SELECT shot_id,
           COUNT(*)                                        AS takes,
           SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
           COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
    FROM generations WHERE shot_id IS NOT NULL GROUP BY shot_id`);
  const stats = new Map<string, { takes: number; ok: number; failed: number; spend: number }>();
  for (const r of rs.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const row = r as any;
    stats.set(row.shot_id, {
      takes: Number(row.takes ?? 0), ok: Number(row.ok ?? 0),
      failed: Number(row.failed ?? 0), spend: Number(row.spend ?? 0),
    });
  }
  return NextResponse.json({
    shots: shots.map((s) => ({
      ...s, ...(stats.get(s.id) ?? { takes: 0, ok: 0, failed: 0, spend: 0 }),
    })),
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));

  const code = String(body.code ?? "").trim();
  const problem = codeProblem(code);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const projectId = scope(body.projectId ? String(body.projectId) : null);
  if (code) {
    const clash = (await listShots(projectId)).find(
      (s) => s.code.toLowerCase() === code.toLowerCase());
    if (clash) return NextResponse.json({ error: `${code} already exists here.` }, { status: 409 });
  }

  const shot = await createShot({
    projectId,
    scene: String(body.scene ?? ""),
    code,
    title: String(body.title ?? ""),
    description: String(body.description ?? ""),
    createdBy: got.user.id,
  });
  return NextResponse.json({ shot });
}
