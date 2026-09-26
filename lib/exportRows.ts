import { db, ready } from "./db";
import { csvCell } from "./csvCell";
import { requireTenant } from "./tenant";
import { creditsApply } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { getSetting } from "./settings";
import { getModel, modelLabel } from "./models";
import { buildFilename } from "./naming";
import { presignedReadUrl, usingBlob, videoPath, imagePath, audioPath, modelPath } from "./storage";
import { originalMediaOf } from "./originalMedia";
import { isDemoMediaUrl } from "./demoProduction";

/**
 * The workspace's takes as rows a spreadsheet can read, each with the
 * master's filename by the workspace's own naming protocol and a link to
 * the master itself — and the masters alone as a manifest for a downloader.
 * The owner's to take, nobody else's (the route checks).
 */
export type ExportRow = {
  id: string; createdAt: number; production: string; shotCode: string; shotTitle: string; take: string;
  kind: string; engine: string; resolution: string; duration: string; status: string;
  credits: number; usd: number; prompt: string; filename: string; url: string; bytes: number | null;
};


/** One row per take, the money column in the workspace's unit. */
export function takesCsv(rows: ExportRow[], unit: "cr" | "$"): string {
  const head = ["id", "created", "production", "shot", "shot_title", "take", "kind", "engine", "resolution", "duration", "status", unit === "cr" ? "credits" : "usd", "prompt", "filename", "url"];
  const lines = rows.map((r) => [
    r.id, new Date(r.createdAt).toISOString(), r.production, r.shotCode, r.shotTitle, r.take, r.kind, r.engine, r.resolution, r.duration, r.status,
    unit === "cr" ? r.credits : Math.round(r.usd * 10000) / 10000, r.prompt, r.filename, r.url,
  ].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

/** Presigns in flight at once: seconds for a few thousand takes, never a flood on the store. */
const PRESIGN_CONCURRENCY = 16;

export async function exportRows(): Promise<{ rows: ExportRow[]; unit: "cr" | "$" }> {
  await ready();
  const ws = requireTenant();
  const unit: "cr" | "$" = creditsApply(ws) ? "cr" : "$";
  const template = await getSetting("namingTemplate");
  const rs = await db().execute(`
    SELECT g.id, g.created_at, g.kind, g.model, g.status, g.version, g.prompt, g.params, g.cost_usd, g.refine_cost_usd, g.bytes, g.stored_url,
           p.name AS project_name, p.code AS project_code, s.scene AS scene, s.code AS shot_code, s.title AS shot_title, u.name AS user_name
    FROM generations g
    LEFT JOIN projects p ON p.id = g.project_id
    LEFT JOIN shots s ON s.id = g.shot_id
    LEFT JOIN users u ON u.id = g.created_by
    WHERE g.deleted = 0 ORDER BY g.created_at ASC`);
  const blob = usingBlob();
  const rows: ExportRow[] = [];
  const masters: { row: ExportRow; pathname: string }[] = [];
  for (const r of rs.rows as unknown as Record<string, unknown>[]) {
    const { kind, ext } = originalMediaOf({ kind: r.kind, params: r.params });
    const model = String(r.model);
    let short = model; try { short = getModel(model).short; } catch { /* a retired id keeps its name */ }
    let p: { resolution?: string; duration?: number } = {};
    try { p = JSON.parse(String(r.params ?? "{}")); } catch { p = {}; }
    const usd = Number(r.cost_usd ?? 0) + Number(r.refine_cost_usd ?? 0);
    const version = r.version == null ? null : Number(r.version);
    const id = String(r.id);
    const filename = buildFilename(template, {
      project: (r.project_name as string | null) ?? null, projectCode: (r.project_code as string | null) ?? null,
      scene: (r.scene as string | null) ?? null, shot: (r.shot_code as string | null) ?? null, shotTitle: (r.shot_title as string | null) ?? null,
      model: short, version, user: (r.user_name as string | null) ?? null, status: String(r.status), id, createdAt: Number(r.created_at ?? 0), ext,
    });
    // A demo take points at shared sample media, not a master this workspace keeps.
    const hasMaster = r.status === "succeeded" && Boolean(r.stored_url) && !isDemoMediaUrl(String(r.stored_url));
    const row: ExportRow = {
      id, createdAt: Number(r.created_at ?? 0),
      production: String(r.project_name ?? ""), shotCode: String(r.shot_code ?? ""), shotTitle: String(r.shot_title ?? ""),
      take: kind === "image" ? `S${version ?? 1}` : kind === "audio" ? "A" : `v${version ?? 1}`,
      kind, engine: modelLabel(model), resolution: p.resolution ? String(p.resolution).toUpperCase() : "",
      duration: kind === "video" && p.duration ? `${p.duration}s` : "", status: String(r.status),
      credits: unit === "cr" ? billCredits(usd, marginKeyOf(kind, model)) : 0, usd: unit === "$" ? usd : 0,
      prompt: String(r.prompt ?? ""), filename, url: hasMaster ? `/api/media/${id}` : "", bytes: r.bytes == null ? null : Number(r.bytes),
    };
    rows.push(row);
    if (hasMaster && blob)
      masters.push({ row, pathname: kind === "image" ? imagePath(id) : kind === "audio" ? audioPath(id) : kind === "model" ? modelPath(id) : videoPath(id) });
  }
  /* Each presign is a round trip to the store. One after another, a few
     hundred takes outran the route's time limit; a bounded pool keeps the
     export to seconds without flooding the store. A presign that fails keeps
     the login-gated link. */
  await eachLimited(masters, PRESIGN_CONCURRENCY, async ({ row, pathname }) => {
    row.url = await presignedReadUrl(pathname, 24).catch(() => row.url);
  });
  return { rows, unit };
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}
