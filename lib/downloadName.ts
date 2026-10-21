/**
 * The name a download leaves with (R9).
 *
 * One place assembles the facts — project, scene, shot, model, version,
 * author — and hands them to the workspace's template. Every surface that
 * offers a file (media route, MCP `get_render`, the CLI's --save) goes
 * through here, so a producer's downloads folder reads the same wherever
 * the file came from.
 */
import { db, ready } from "@/lib/db";
import { buildFilename } from "@/lib/naming";
import { getSetting } from "@/lib/settings";
import { getModel } from "@/lib/models";

/**
 * The name of an id that names no take: the template with the id alone. A take
 * the caller may not read is answered with exactly this, so a name never says
 * whether the take is there (app/api/workbench/export-names).
 */
export async function noTakeFilename(genId: string, ext: string): Promise<string> {
  return buildFilename(await getSetting("namingTemplate"), { id: genId, ext });
}

export async function downloadFilename(genId: string, ext: string): Promise<string> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT g.id, g.model, g.status, g.version, g.created_at,
                 p.name AS project_name, p.code AS project_code,
                 s.scene AS scene, s.code AS shot_code, s.title AS shot_title,
                 u.name AS user_name
          FROM generations g
          LEFT JOIN projects p ON p.id = g.project_id
          LEFT JOIN shots    s ON s.id = g.shot_id
          LEFT JOIN users    u ON u.id = g.created_by
          WHERE g.id = ?`,
    args: [genId],
  });
  if (!rs.rows.length) return noTakeFilename(genId, ext);
  const template = await getSetting("namingTemplate");

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const r = rs.rows[0] as any;
  let short = r.model as string;
  try { short = getModel(r.model).short; } catch { /* retired id — keep the raw one */ }

  return buildFilename(template, {
    project: r.project_name,
    projectCode: r.project_code,
    scene: r.scene,
    shot: r.shot_code,
    shotTitle: r.shot_title,
    model: short,
    version: r.version == null ? null : Number(r.version),
    user: r.user_name,
    status: r.status,
    id: r.id,
    createdAt: Number(r.created_at ?? 0),
    ext,
  });
}
