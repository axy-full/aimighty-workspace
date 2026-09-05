import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { listShots, createShot, codeProblem } from "@/lib/shots";

export const dynamic = "force-dynamic";

const scope = (v: string | null) =>
  v && v !== "all" && v !== "unfiled" ? v : null;

/* eslint-disable @typescript-eslint/no-explicit-any */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = scope(new URL(req.url).searchParams.get("projectId"));
  const shots = await listShots(projectId);

  /* Counts per shot in one pass — the shot list doubles as the revision
   * report. Scoped to the shots we just listed: this runs every time the
   * composer opens, and an unscoped GROUP BY over generations would become a
   * full scan of the whole table as the library grows (R5). */
  await ready();
  const stats = new Map<string, { takes: number; ok: number; failed: number; spend: number }>();
  if (shots.length) {
    const ids = shots.map((s) => s.id);
    const rs = await db().execute({
      sql: `SELECT shot_id,
                   COUNT(*)                                            AS takes,
                   SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok,
                   SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed,
                   COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend
            FROM generations
            WHERE shot_id IN (${ids.map(() => "?").join(",")})
            GROUP BY shot_id`,
      args: ids,
    });
    for (const r of rs.rows) {
      const row = r as any;
      stats.set(row.shot_id, {
        takes: Number(row.takes ?? 0), ok: Number(row.ok ?? 0),
        failed: Number(row.failed ?? 0), spend: Number(row.spend ?? 0),
      });
    }
  }
  /* The write-back half: where each shot stands and which take is its
     master. Video takes only — a still or a track never approves a shot. */
  const back = new Map<string, { state: string; master: { id: string; version: number | null; url: string | null } | null }>();
  const sids = shots.map((s) => s.id);
  if (sids.length) {
    const rs = await db().execute({
      sql: `SELECT shot_id, id, version, status, review_state, stored_url, source_url
            FROM generations
            WHERE shot_id IN (${sids.map(() => "?").join(",")}) AND deleted = 0 AND kind = 'video'
            ORDER BY version DESC`,
      args: sids,
    });
    const byShot = new Map<string, any[]>();
    for (const r of rs.rows as any[]) (byShot.get(r.shot_id) ?? byShot.set(r.shot_id, []).get(r.shot_id)!).push(r);
    for (const [sid, list] of byShot) {
      const approved = list.find((r) => r.review_state === "approved");
      const picked = list.find((r) => r.review_state === "picked");
      const live = list.some((r) => r.status === "queued" || r.status === "running");
      const state = approved ? "approved" : picked ? "picked" : live ? "rendering" : list.length ? "draft" : "none";
      back.set(sid, {
        state,
        master: approved ? { id: approved.id, version: approved.version == null ? null : Number(approved.version), url: approved.stored_url ?? approved.source_url ?? null } : null,
      });
    }
  }
  return NextResponse.json({
    shots: shots.map((s) => ({
      ...s, ...(stats.get(s.id) ?? { takes: 0, ok: 0, failed: 0, spend: 0 }),
      ...(back.get(s.id) ?? { state: s.kind === "type" ? "type" : "none", master: null }),
    })),
  });
});

export const POST = withTenant(async function POST(req: Request) {
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
    planned: body.planned == null || body.planned === "" ? null : Number(body.planned),
    setup: body.setup && typeof body.setup === "object" ? body.setup : undefined,
    cast: Array.isArray(body.cast) ? body.cast.map(String) : undefined,
    kind: body.kind === "type" ? "type" : undefined,
    description: String(body.description ?? ""),
    createdBy: got.user.id,
  });
  return NextResponse.json({ shot });
});
