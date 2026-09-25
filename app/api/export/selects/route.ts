import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { buildFilename } from "@/lib/naming";
import { getModel } from "@/lib/models";
import { billCredits } from "@/lib/creditTerms";
import { creditsApply } from "@/lib/credits";
import { currentTenant } from "@/lib/tenant";
import { openMediaStream } from "@/lib/storage";
import { zipStream, zipName, uniqueNames } from "@/lib/zip";
import { selectsCsv, type Select } from "@/lib/selects";
import { originalKindOf, originalMediaOf } from "@/lib/originalMedia";

export const dynamic = "force-dynamic";
/* A package of every approved master streams for as long as the producer's
   connection takes to drain it (lib/zip.ts reads storage only as it does). */
export const maxDuration = 800;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function approvedSelects(projectId: string): Promise<{ rows: Select[]; production: string }> {
  await ready();
  const p = await db().execute({ sql: `SELECT name FROM projects WHERE id = ? LIMIT 1`, args: [projectId] });
  const production = p.rows.length ? String((p.rows[0] as any).name ?? "") : "";
  const template = await getSetting("namingTemplate");
  const rs = await db().execute({
    sql: `SELECT g.id, g.kind, g.model, g.version, g.created_at, g.prompt, g.params, g.cost_usd, g.refine_cost_usd, g.status,
                 s.code AS shot_code, s.title AS shot_title, s.scene AS scene, s.position AS shot_pos,
                 p.name AS project_name, p.code AS project_code, u.name AS user_name
          FROM generations g
          LEFT JOIN shots s ON s.id = g.shot_id
          LEFT JOIN projects p ON p.id = g.project_id
          LEFT JOIN users u ON u.id = g.created_by
          WHERE g.project_id = ? AND g.review_state = 'approved' AND g.deleted = 0 AND g.status = 'succeeded'
          ORDER BY COALESCE(s.position, 1e9), s.code, g.version`,
    args: [projectId],
  });
  const rows: Select[] = (rs.rows as any[]).map((r) => {
    const params = ((): Record<string, unknown> => { try { return JSON.parse(r.params || "{}"); } catch { return {}; } })();
    let short = String(r.model ?? "");
    try { short = getModel(String(r.model)).short; } catch { /* a retired id keeps its own name */ }
    const usd = Number(r.cost_usd ?? 0) + Number(r.refine_cost_usd ?? 0);
    const { kind, ext } = originalMediaOf({ kind: r.kind, params });
    return {
      id: String(r.id), shot: String(r.shot_code ?? ""), shotTitle: String(r.shot_title ?? ""),
      version: Number(r.version ?? 1), kind,
      engine: short, credits: billCredits(usd, String(r.model ?? "")), usd,
      seconds: Number((params.duration as number | undefined) ?? 0),
      prompt: String((params.rawPrompt as string | undefined) ?? r.prompt ?? "").split(/\n\s*\n/)[0],
      filename: buildFilename(template, {
        project: r.project_name, projectCode: r.project_code, scene: r.scene, shot: r.shot_code,
        shotTitle: r.shot_title, model: short, version: r.version == null ? null : Number(r.version),
        user: r.user_name, status: r.status, id: String(r.id), createdAt: Number(r.created_at ?? 0), ext,
      }),
    };
  });
  return { rows, production };
}

/**
 * The selects, on the way out (brief 2.6): one production's Approved takes
 * as a zip of masters named by the workspace's own convention, a shot list
 * to bill from, or an edit list an editor can conform against.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const format = url.searchParams.get("format") ?? "zip";
  if (!projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });

  const { rows, production } = await approvedSelects(projectId);
  const unit: "cr" | "$" = creditsApply(currentTenant()?.workspace) ? "cr" : "$";
  const stem = (production || "production").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "production";
  if (!rows.length) return NextResponse.json({ error: "Nothing is approved in this production yet." }, { status: 404 });

  if (format === "csv") {
    return new Response(selectsCsv(rows, unit), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${stem}_selects.csv"`, "Cache-Control": "no-store" },
    });
  }
  /* The masters, plus the shot list beside them, so a zip is the whole
     handover. There used to be an EDL in here as well; it is gone. */
  const names = uniqueNames(rows.map((r, i) => zipName(r.filename, `take_${i + 1}.${r.filename.split(".").pop() || "mp4"}`)));
  const enc = new TextEncoder();
  const entries = [
    ...rows.map((r, i) => ({
      name: names[i],
      body: async () => openMediaStream(r.id, originalKindOf(r.kind)),
    })),
    { name: `${stem}_selects.csv`, body: async () => enc.encode(selectsCsv(rows, unit)) },
  ];
  return new Response(zipStream(entries), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${stem}_selects.zip"`, "Cache-Control": "no-store" },
  });
});
