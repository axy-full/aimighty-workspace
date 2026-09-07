import { db, ready, now, id } from "./db";
import { createShot } from "./shots";
import { invalidate, PROJECTS_KEY } from "./cache";
import { starterShotsWithSetup } from "./platformLayer";
import { listPlatformAssets, getPlatformLayer } from "./platform";
import { DEMO_TAKES, demoMediaUrl } from "./demoProduction";

/**
 * Seed the starter production into the current workspace — once. Called
 * when a workspace is created; harmless to call again.
 */
export async function seedStarterProduction(createdBy: string): Promise<{ projectId: string } | null> {
  await ready();
  const have = await db().execute(`SELECT id FROM projects WHERE starter = 1 LIMIT 1`);
  if (have.rows.length) return null;
  const layer = await getPlatformLayer();
  const starter = layer.starter;
  const pid = id("prj");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO projects (id, name, description, created_at, code, starter, cap_credits) VALUES (?,?,?,?,?,1,?)`,
    args: [pid, starter.name, starter.description, ts, starter.code, layer.caps.defaultCapCredits],
  });
  for (const c of starter.cast) {
    await db().execute({
      sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,?,?,NULL,?,?)`,
      args: [id("cast"), pid, c.name, c.kind, c.description, createdBy, ts],
    });
  }
  for (const s of starterShotsWithSetup(layer)) {
    await createShot({
      projectId: pid, scene: "", code: s.code, title: s.title, description: s.description,
      planned: s.planned, setup: s.setup, cast: s.cast, kind: "render", createdBy,
    });
  }
  invalidate(PROJECTS_KEY);
  await seedDemoTakes(pid, createdBy, ts);
  return { projectId: pid };
}

/**
 * The demo production's takes, as this workspace's own rows (brief 1.7):
 * editable, deletable, filed under the starter's shots with real credit
 * numbers, one Approved. Their pictures are the platform's neutral previews
 * when published, else the fixture clip; nothing was rendered, so nothing
 * is metered.
 */
async function seedDemoTakes(projectId: string, createdBy: string, ts: number): Promise<void> {
  const published = new Set((await listPlatformAssets("previews/").catch(() => [])).map((a) => a.key.replace(/^previews\//, "")));
  const shots = await db().execute({ sql: `SELECT id, code, setup FROM shots WHERE project_id = ?`, args: [projectId] });
  const byCode = new Map((shots.rows as unknown as { id: string; code: string; setup: string }[]).map((r) => [r.code, r]));
  let i = 0;
  for (const t of DEMO_TAKES) {
    const shot = byCode.get(t.shotCode); if (!shot) continue;
    let setup: Record<string, string> = {};
    try { setup = JSON.parse(shot.setup || "{}"); } catch { setup = {}; }
    const params = {
      ratio: "16:9", resolution: t.resolution, duration: t.duration, generateAudio: true, watermark: false,
      shotSpec: { ...setup, [t.previewKey.startsWith("technique:") ? "technique" : "move"]: t.move },
      rawPrompt: t.prompt, demo: true,
    };
    const made = ts - (DEMO_TAKES.length - i) * 90_000; i++;
    await db().execute({
      sql: `INSERT INTO generations
            (id, project_id, ark_task_id, kind, model, prompt, params, status, source_url, stored_url, cost_usd, created_by,
             created_at, updated_at, shot_id, version, provider, task, review_state, review_by, reviewed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id("gen"), projectId, null, "video", t.model, t.prompt, JSON.stringify(params), "succeeded", null, demoMediaUrl(t.previewKey, published), t.costUsd, createdBy,
             made, made, shot.id, t.version, "byteplus", "generate", t.approved ? "approved" : "", t.approved ? createdBy : null, t.approved ? made + 60_000 : null],
    });
  }
}
