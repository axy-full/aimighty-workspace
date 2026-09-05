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

  /* One grouped pass over generations for the counts and the money, then a
     handful of correlated subqueries for the shot-level facts the Projects
     table shows. Those touch the shots table and a filtered slice of
     generations per project; projects number in the tens and the memo
     above shares one read across tabs, so this stays cheap. */
  const rs = await db().execute(`
    SELECT p.*,
           COALESCE(g.n, 0)     AS gen_count,
           COALESCE(g.spend, 0) AS spend,
           COALESCE(g.live, 0)  AS live,
           (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shots,
           (SELECT COUNT(DISTINCT x.shot_id) FROM generations x
             WHERE x.deleted = 0 AND x.review_state = 'approved'
               AND x.shot_id IN (SELECT s.id FROM shots s WHERE s.project_id = p.id)) AS approved_shots,
           (SELECT COUNT(DISTINCT x.shot_id) FROM generations x
             WHERE x.deleted = 0 AND x.review_state = 'picked'
               AND x.shot_id IN (SELECT s.id FROM shots s WHERE s.project_id = p.id)) AS picked_shots,
           (SELECT GROUP_CONCAT(DISTINCT u.name) FROM generations x JOIN users u ON u.id = x.created_by
             WHERE x.project_id = p.id) AS team,
           (SELECT COUNT(*) FROM treatments t WHERE t.project_id = p.id) AS from_atomik,
           (SELECT MAX(s.synced_at) FROM shots s WHERE s.project_id = p.id) AS synced_at,
           (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id AND s.dirty = 1) AS unsent
    FROM projects p
    LEFT JOIN (
      SELECT project_id,
             SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS n,
             SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS live,
             COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)), 0) AS spend
      FROM generations GROUP BY project_id
    ) g ON g.project_id = p.id
    ORDER BY p.created_at DESC
  `);
  /* The newest render per project, for LAST ACTIVITY: who did what, when.
     A window function keeps it one query. */
  const last = await db().execute(`
    SELECT * FROM (
      SELECT x.project_id, x.kind, x.status, x.review_state, x.updated_at, x.version,
             u.name AS who, s.code AS shot_code,
             ROW_NUMBER() OVER (PARTITION BY x.project_id ORDER BY x.updated_at DESC) AS rn
      FROM generations x
      LEFT JOIN users u ON u.id = x.created_by
      LEFT JOIN shots s ON s.id = x.shot_id
      WHERE x.project_id IS NOT NULL
    ) WHERE rn = 1
  `);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lastBy = new Map<string, { at: number; who: string | null; what: string }>();
  for (const r of last.rows as any[]) {
    const what = r.shot_code
      ? `${r.shot_code}${r.version ? ` v${r.version}` : ""}`
      : r.kind === "image" ? "a still" : r.kind === "audio" ? "a track" : "a clip";
    const verb = r.review_state === "approved" ? "approved" : r.review_state === "picked" ? "picked"
      : r.status === "queued" || r.status === "running" ? "rendering" : r.status === "failed" ? "failed on" : "rendered";
    lastBy.set(String(r.project_id), { at: Number(r.updated_at), who: r.who ?? null, what: `${verb} ${what}` });
  }
  const body = {
    projects: rs.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code ?? "",
      category: r.category ?? "",
      description: r.description,
      createdAt: Number(r.created_at),
      genCount: Number(r.gen_count),
      spend: Number(r.spend),
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      kind: r.kind ?? null,
      runtimeTarget: r.runtime_target == null ? null : Number(r.runtime_target),
      stage: r.stage ?? null,
      live: Number(r.live ?? 0),
      shots: Number(r.shots ?? 0),
      approvedShots: Number(r.approved_shots ?? 0),
      pickedShots: Number(r.picked_shots ?? 0),
      team: r.team ? String(r.team).split(",").map((n: string) => n.trim()).filter(Boolean) : [],
      last: lastBy.get(String(r.id)) ?? null,
      /* Born in Atomik (it has a treatment), and whether the shot list has been sent across since its last edit. */
      fromAtomik: Number(r.from_atomik ?? 0) > 0,
      syncedAt: r.synced_at == null ? null : Number(r.synced_at),
      unsent: Number(r.unsent ?? 0),
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
