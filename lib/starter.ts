import { db, ready, now, id } from "./db";
import { createShot } from "./shots";
import { createProduction } from "./productions";
import { invalidate, PROJECTS_KEY } from "./cache";
import { starterShotsWithSetup } from "./platformLayer";
import { createElement } from "./elements";
import { elementKind } from "./rig";
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
  /* The project is born under its production, the way every other project is — not left for the
     next boot's orphan pass, which this process has already run. */
  const productionId = await createProduction({ name: starter.name, capCredits: layer.caps.defaultCapCredits });
  await db().execute({
    sql: `INSERT INTO projects (id, name, description, created_at, code, starter, cap_credits, production_id) VALUES (?,?,?,?,?,1,?,?)`,
    args: [pid, starter.name, starter.description, ts, starter.code, layer.caps.defaultCapCredits, productionId],
  });
  for (const c of starter.cast) {
    await db().execute({
      sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,?,?,NULL,?,?)`,
      args: [id("cast"), pid, c.name, c.kind, c.description, createdBy, ts],
    });
  }
  /* The Library is never empty on first open (docs/change-request-1.md §5):
     every starter cast member is an asset under its label from the start —
     nothing trained, no still yet, a version a minute away. `cast_id` and
     `mirrored_at` tell the Library's backfill these are done. Best effort:
     a failed asset never costs the workspace its production. */
  const castRows = await db().execute({ sql: `SELECT id, name, kind, description FROM cast_members WHERE project_id = ?`, args: [pid] });
  for (const c of castRows.rows as unknown as { id: string; name: string; kind: string; description: string }[]) {
    try {
      const el = await createElement({ name: c.name, kind: elementKind(c.kind), description: c.description, projectId: pid, castId: c.id }, createdBy);
      await db().execute({ sql: `UPDATE elements SET mirrored_at = ?, updated_at = ? WHERE id = ?`, args: [ts, ts, el.id] });
    } catch (e) { console.warn(`[starter] asset ${c.name} not seeded: ${(e as Error).message}`); }
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
