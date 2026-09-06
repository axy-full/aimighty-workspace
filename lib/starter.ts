import { db, ready, now, id } from "./db";
import { createShot } from "./shots";
import { invalidate, PROJECTS_KEY } from "./cache";
import { STARTER_PRODUCTION } from "./platformLayer";

/**
 * Seed the starter production into the current workspace — once. Called
 * when a workspace is created; harmless to call again.
 */
export async function seedStarterProduction(createdBy: string): Promise<{ projectId: string } | null> {
  await ready();
  const have = await db().execute(`SELECT id FROM projects WHERE starter = 1 LIMIT 1`);
  if (have.rows.length) return null;
  const pid = id("prj");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO projects (id, name, description, created_at, code, starter) VALUES (?,?,?,?,?,1)`,
    args: [pid, STARTER_PRODUCTION.name, STARTER_PRODUCTION.description, ts, STARTER_PRODUCTION.code],
  });
  for (const c of STARTER_PRODUCTION.cast) {
    await db().execute({
      sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,?,?,NULL,?,?)`,
      args: [id("cast"), pid, c.name, c.kind, c.description, createdBy, ts],
    });
  }
  for (const s of STARTER_PRODUCTION.shots) {
    await createShot({
      projectId: pid, scene: "", code: s.code, title: s.title, description: s.description,
      planned: s.planned, setup: s.setup, cast: s.cast, kind: "render", createdBy,
    });
  }
  invalidate(PROJECTS_KEY);
  return { projectId: pid };
}
