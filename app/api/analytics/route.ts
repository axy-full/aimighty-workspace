import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { modelLabel } from "@/lib/models";
import { requireUser, withTenant } from "@/lib/auth";
import { billedCreditsSum } from "@/lib/creditSql";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * R1 + R2 — what a project cost, and where production is getting stuck.
 *
 * One endpoint serves both the per-project overview and the management
 * dashboard; `projectId` narrows it. Everything is computed in SQL and
 * grouped in one pass per question, because this has to stay cheap on a
 * table with thousands of rows (R5).
 *
 * The money figure is always all-in: the render plus its prompt refinement.
 * Deleted renders still count — money spent is money spent, and a ledger
 * that forgets binned takes flatters the project.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const url = new URL(req.url);
  const raw = url.searchParams.get("projectId");
  const projectId = raw && raw !== "all" && raw !== "unfiled" ? raw : null;
  const days = Math.max(0, Math.min(365, Number(url.searchParams.get("days") ?? 0)));
  const since = days ? Date.now() - days * 86400_000 : 0;

  // Scope clause reused by every query below.
  const where: string[] = [];
  const args: any[] = [];
  if (projectId) { where.push("g.project_id = ?"); args.push(projectId); }
  else if (raw === "unfiled") where.push("g.project_id IS NULL");
  if (since) { where.push("g.created_at >= ?"); args.push(since); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const SPEND = `COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0)`;
  const CREDITS = billedCreditsSum("g");

  const [totals, byProject, byPerson, byModel, byShot, byStatus, byDay, stuck, byCategory, iteration] =
    await Promise.all([
      // Headline: volume, outcome, spend, and how much wall-clock the
      // machines actually burned on this work.
      db().execute({ sql: `
        SELECT COUNT(*) AS n,
               SUM(g.status='succeeded') AS ok,
               SUM(g.status='failed')    AS failed,
               SUM(g.status NOT IN ('succeeded','failed','cancelled')) AS pending,
               SUM(g.deleted=1)          AS binned,
               ${SPEND} AS spend, ${CREDITS} AS credits,
               COALESCE(SUM(COALESCE(g.refine_cost_usd,0)),0) AS prompt_spend,
               SUM(g.refine_model IS NOT NULL) AS prompts,
               COALESCE(SUM(g.total_tokens),0) AS tokens,
               COALESCE(SUM(g.duration_ms),0)  AS render_ms,
               COUNT(DISTINCT g.created_by)    AS people,
               COUNT(DISTINCT g.shot_id)       AS shots
        FROM generations g ${W}`, args }),

      db().execute({ sql: `
        SELECT COALESCE(p.name,'Unfiled') AS name, p.id AS id,
               COUNT(*) AS n, ${SPEND} AS spend, ${CREDITS} AS credits,
               SUM(g.status='failed') AS failed,
               COUNT(DISTINCT g.created_by) AS people,
               COALESCE(SUM(g.duration_ms),0) AS render_ms
        FROM generations g LEFT JOIN projects p ON p.id = g.project_id ${W}
        GROUP BY g.project_id ORDER BY spend DESC LIMIT 60`, args }),

      db().execute({ sql: `
        SELECT COALESCE(u.name,'Unknown') AS name, g.created_by AS id,
               COUNT(*) AS n, ${SPEND} AS spend, ${CREDITS} AS credits,
               SUM(g.status='failed') AS failed,
               COUNT(DISTINCT g.project_id) AS projects
        FROM generations g LEFT JOIN users u ON u.id = g.created_by ${W}
        GROUP BY g.created_by ORDER BY spend DESC LIMIT 60`, args }),

      db().execute({ sql: `
        SELECT g.model AS model, COUNT(*) AS n, ${SPEND} AS spend, ${CREDITS} AS credits,
               SUM(g.status='failed') AS failed,
               AVG(NULLIF(g.duration_ms,0)) AS avg_ms
        FROM generations g ${W}
        GROUP BY g.model ORDER BY spend DESC`, args }),

      // R2's "revisions per shot" — the number that tells a producer which
      // setup is fighting them.
      db().execute({ sql: `
        SELECT s.id AS id, s.code AS code, s.scene AS scene, s.title AS title,
               s.status AS status,
               COUNT(*) AS takes, ${SPEND} AS spend, ${CREDITS} AS credits,
               SUM(g.status='succeeded') AS ok,
               SUM(g.status='failed')    AS failed,
               MAX(g.version) AS latest
        FROM generations g JOIN shots s ON s.id = g.shot_id
        ${W} GROUP BY s.id ORDER BY takes DESC, spend DESC LIMIT 100`, args }),

      db().execute({ sql: `
        SELECT g.status AS status, COUNT(*) AS n FROM generations g ${W}
        GROUP BY g.status`, args }),

      db().execute({ sql: `
        SELECT CAST(g.created_at/86400000 AS INTEGER) AS day,
               COUNT(*) AS n, ${SPEND} AS spend, ${CREDITS} AS credits
        FROM generations g ${W}
        GROUP BY day ORDER BY day DESC LIMIT 60`, args }),

      // Where things stall: the slowest and the most-retried combinations.
      db().execute({ sql: `
        SELECT g.model AS model,
               json_extract(g.params,'$.resolution') AS resolution,
               COUNT(*) AS n,
               AVG(NULLIF(g.duration_ms,0)) AS avg_ms,
               MAX(g.duration_ms) AS max_ms,
               SUM(g.status='failed') AS failed,
               SUM(CASE WHEN g.attempts > 1 THEN 1 ELSE 0 END) AS retried
        FROM generations g ${W}
        GROUP BY g.model, resolution
        HAVING n >= 1 ORDER BY avg_ms DESC LIMIT 30`, args }),

      // Genre / category performance — whether a music video behaves like a
      // TVC, which is the axis a producer quotes from.
      db().execute({ sql: `
        SELECT CASE WHEN p.category IS NULL OR p.category = '' THEN 'Uncategorised'
                    ELSE p.category END AS category,
               COUNT(*) AS n, ${SPEND} AS spend, ${CREDITS} AS credits,
               SUM(g.status='failed') AS failed,
               AVG(NULLIF(g.duration_ms,0)) AS avg_ms,
               COUNT(DISTINCT g.project_id) AS projects,
               COUNT(DISTINCT g.shot_id) AS shots
        FROM generations g LEFT JOIN projects p ON p.id = g.project_id ${W}
        GROUP BY category ORDER BY spend DESC`, args }),

      // Prompting and iteration patterns: how long prompts run, how often the
      // refine layer is bypassed, and how many takes a shot really needs.
      db().execute({ sql: `
        SELECT AVG(LENGTH(g.prompt)) AS avg_prompt_len,
               SUM(CASE WHEN g.refine_model IS NOT NULL THEN 1 ELSE 0 END) AS refined,
               SUM(CASE WHEN g.shot_id IS NOT NULL THEN 1 ELSE 0 END) AS filed,
               COUNT(DISTINCT g.shot_id) AS shots,
               SUM(CASE WHEN json_extract(g.params,'$.cast') IS NOT NULL THEN 1 ELSE 0 END) AS with_cast,
               SUM(CASE WHEN json_extract(g.params,'$.references') != '[]'
                         AND json_extract(g.params,'$.references') IS NOT NULL THEN 1 ELSE 0 END) AS with_refs
        FROM generations g ${W}`, args }),
    ]);

  const num = (v: any) => Number(v ?? 0);
  const t = totals.rows[0] as any;
  const it = iteration.rows[0] as any;
  const label = (m: string) => modelLabel(m);

  // Credit is workspace-wide, so it ignores the project filter.
  const topups = await db().execute(`SELECT COALESCE(SUM(amount_usd),0) AS total FROM topups`);
  const allSpend = await db().execute(
    `SELECT COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS s FROM generations`);

  const filed = num(it?.filed);
  const shots = num(it?.shots);

  return NextResponse.json({
    scope: { projectId: raw ?? "all", days },
    totals: {
      generations: num(t?.n),
      succeeded: num(t?.ok),
      failed: num(t?.failed),
      pending: num(t?.pending),
      binned: num(t?.binned),
      spend: num(t?.spend),
      credits: num(t?.credits),
      /** The prompt writer's share of `spend`, and how many prompts it wrote. */
      promptSpend: num(t?.prompt_spend),
      prompts: num(t?.prompts),
      tokens: num(t?.tokens),
      /** Machine time, not people time — the honest version of "hours on this project". */
      renderMs: num(t?.render_ms),
      people: num(t?.people),
      shots: num(t?.shots),
      successRate: num(t?.n) ? num(t?.ok) / num(t?.n) : 0,
    },
    credit: {
      toppedUp: num((topups.rows[0] as any)?.total),
      spentAllTime: num((allSpend.rows[0] as any)?.s),
    },
    byProject: byProject.rows.map((r: any) => ({
      id: r.id ?? null, name: r.name, n: num(r.n), spend: num(r.spend), credits: num(r.credits),
      failed: num(r.failed), people: num(r.people), renderMs: num(r.render_ms),
    })),
    byPerson: byPerson.rows.map((r: any) => ({
      id: r.id, name: r.name, n: num(r.n), spend: num(r.spend), credits: num(r.credits),
      failed: num(r.failed), projects: num(r.projects),
    })),
    byModel: byModel.rows.map((r: any) => ({
      model: r.model, label: label(r.model), n: num(r.n), spend: num(r.spend), credits: num(r.credits),
      failed: num(r.failed), avgMs: r.avg_ms == null ? null : num(r.avg_ms),
    })),
    byShot: byShot.rows.map((r: any) => ({
      id: r.id, code: r.code, scene: r.scene, title: r.title, status: r.status,
      takes: num(r.takes), spend: num(r.spend), credits: num(r.credits), ok: num(r.ok),
      failed: num(r.failed), latest: num(r.latest),
    })),
    byStatus: byStatus.rows.map((r: any) => ({ status: r.status, n: num(r.n) })),
    byDay: byDay.rows.map((r: any) => ({
      day: num(r.day) * 86400000, n: num(r.n), spend: num(r.spend), credits: num(r.credits),
    })).reverse(),
    stuck: stuck.rows.map((r: any) => ({
      model: label(r.model), resolution: r.resolution ?? "—", n: num(r.n),
      avgMs: r.avg_ms == null ? null : num(r.avg_ms), maxMs: num(r.max_ms),
      failed: num(r.failed), retried: num(r.retried),
    })),
    byCategory: byCategory.rows.map((r: any) => ({
      category: r.category, n: num(r.n), spend: num(r.spend), credits: num(r.credits), failed: num(r.failed),
      avgMs: r.avg_ms == null ? null : num(r.avg_ms),
      projects: num(r.projects), shots: num(r.shots),
    })),
    patterns: {
      avgPromptLength: Math.round(num(it?.avg_prompt_len)),
      refined: num(it?.refined),
      withCast: num(it?.with_cast),
      withReferences: num(it?.with_refs),
      filedToShots: filed,
      unfiled: num(t?.n) - filed,
      /** The iteration number: takes per shot. 1.0 means nobody revises. */
      takesPerShot: shots ? filed / shots : 0,
    },
  });
});
