import type { Transaction } from "@libsql/client";
import { db, ready, now, id } from "./db";
import { invalidate, PROJECTS_KEY } from "./cache";
import { starterShotsWithSetup, type StarterShot } from "./platformLayer";
import { listPlatformAssets, getPlatformLayer } from "./platform";
import { DEMO_TAKES, demoMediaUrl } from "./demoProduction";
import { mediaMutation, validateMediaSources } from "./mediaMutation";

/** The workspace's starter production, if it has one. `db()` is the workspace's own database. */
export async function starterProductionId(): Promise<string | null> {
  await ready();
  const row = (await db().execute(`SELECT id FROM projects WHERE starter = 1 ORDER BY created_at ASC, id ASC LIMIT 1`)).rows[0];
  return row ? String(row.id) : null;
}

/**
 * Seed the starter production into the current workspace, once. Nothing runs
 * it by itself: the Studio's "Explore the starter production" does
 * (POST /api/workbench/projects › starter), when a person presses it.
 *
 * It is one write transaction, and the "is there one already?" check runs
 * inside it. So two presses (a double click, a retried request, two
 * teammates at once) make one production, never two and never half of one.
 * The one it made is returned; null means one was already there.
 *
 * It sends no engine request and writes no charge. There are no meter
 * events and no billing-ledger rows, and the takes carry no spend (see
 * seedDemoTakes).
 */
export async function seedStarterProduction(createdBy: string): Promise<{ projectId: string } | null> {
  await ready();
  if (await starterProductionId()) return null;
  /* Platform reads happen before the transaction: its callback may only use its own connection. */
  const layer = await getPlatformLayer();
  const starter = layer.starter;
  const shots = starterShotsWithSetup(layer);
  const published = new Set((await listPlatformAssets("previews/").catch(() => [])).map((a) => a.key.replace(/^previews\//, "")));
  const pid = id("prj");
  const production = id("prod");
  const ts = now();
  const made = await mediaMutation(async (tx) => {
    if ((await tx.execute(`SELECT id FROM projects WHERE starter = 1 LIMIT 1`)).rows.length) return false;
    /* A production of its own, so it is on the Productions board from the start, like one the Studio links (lib/workbench/records.ts). */
    await tx.execute({ sql: `INSERT INTO productions (id, name, created_at) VALUES (?,?,?)`, args: [production, starter.name, ts] });
    await tx.execute({
      sql: `INSERT INTO projects (id, name, description, created_at, code, starter, cap_credits, production_id, format) VALUES (?,?,?,?,?,1,?,?,?)`,
      args: [pid, starter.name, starter.description, ts, starter.code, layer.caps.defaultCapCredits, production, "16:9"],
    });
    for (const c of starter.cast) {
      await tx.execute({
        sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,?,?,NULL,?,?)`,
        args: [id("cast"), pid, c.name, c.kind, c.description, createdBy, ts],
      });
    }
    const byCode = new Map<string, { id: string; setup: StarterShot["setup"] }>();
    for (const [position, s] of shots.entries()) {
      byCode.set(s.code, await insertShot(tx, { projectId: pid, shot: s, position, createdBy, ts }));
    }
    await seedDemoTakes(tx, pid, byCode, createdBy, ts, published);
    return true;
  });
  if (!made) return null;
  invalidate(PROJECTS_KEY);
  return { projectId: pid };
}

/** The same row lib/shots.ts createShot writes, on the seed's own transaction. */
async function insertShot(tx: Transaction, input: { projectId: string; shot: StarterShot; position: number; createdBy: string; ts: number }) {
  const { shot } = input;
  await validateMediaSources(tx, shot.setup);
  const sid = id("shot");
  await tx.execute({
    sql: `INSERT INTO shots (id, project_id, scene, code, title, description, status, position,
                             created_by, created_at, updated_at, planned, setup, cast, kind, dirty, engine)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
    args: [sid, input.projectId, "", shot.code.trim(), shot.title.trim().slice(0, 160), shot.description.slice(0, 2000),
           "open", input.position, input.createdBy, input.ts, input.ts,
           Math.max(1, Math.min(60, Math.round(shot.planned))), JSON.stringify(shot.setup ?? {}), JSON.stringify(shot.cast.slice(0, 20)), "render"],
  });
  return { id: sid, setup: shot.setup };
}

/**
 * The demo production's takes, as this workspace's own rows (brief 1.7):
 * editable, filed under the starter's shots, one Approved. Their pictures
 * are the platform's neutral previews when published, else the fixture clip.
 * Nothing was rendered, so nothing is metered and nothing is spent:
 * `cost_usd` is 0, not the demo's price. Every spend total, cap and credit
 * figure sums that column (lib/caps.ts spentBy, lib/creditSql.ts, the usage
 * routes). The demo's price stays in `params.demoCostUsd`, for display only.
 * It is 0 rather than NULL because the recovery sweep (lib/jobs.ts) picks up
 * a succeeded take with no cost to settle it with its engine, and a demo take
 * has no engine job to ask.
 *
 * `duration_s` and `bytes` stay NULL on every one of these rows, deliberately.
 * These takes were never sealed by a render path, and the media they point at is
 * not a stored original of this workspace — it is the shared platform preview or
 * `public/fixtures/clip.mp4` (see `isDemoMediaUrl`), which the bounded inspectors
 * in lib/videoMetadata.server.ts cannot open, because they resolve a
 * generation's bytes under the workspace's own Blob prefix. `params.duration`
 * below is a DEMO_TAKES fixture, for display and for the demo's own credit
 * numbers; copying it into `duration_s` would make a demo take quotable at a
 * guessed length, which is the wrong bill the pricing rules forbid. A demo take
 * is therefore non-quotable: lib/mediaSource.server.ts refuses it with a reason
 * instead of measuring or persisting anything.
 */
async function seedDemoTakes(tx: Transaction, projectId: string, byCode: Map<string, { id: string; setup: StarterShot["setup"] }>, createdBy: string, ts: number, published: ReadonlySet<string>): Promise<void> {
  let i = 0;
  for (const t of DEMO_TAKES) {
    const shot = byCode.get(t.shotCode); if (!shot) continue;
    const params = {
      ratio: "16:9", resolution: t.resolution, duration: t.duration, generateAudio: true, watermark: false,
      shotSpec: { ...shot.setup, [t.previewKey.startsWith("technique:") ? "technique" : "move"]: t.move },
      rawPrompt: t.prompt, demo: true, demoCostUsd: t.costUsd,
    };
    const made = ts - (DEMO_TAKES.length - i) * 90_000; i++;
    await tx.execute({
      sql: `INSERT INTO generations
            (id, project_id, ark_task_id, kind, model, prompt, params, status, source_url, stored_url, cost_usd, created_by,
             created_at, updated_at, shot_id, version, provider, task, review_state, review_by, reviewed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id("gen"), projectId, null, "video", t.model, t.prompt, JSON.stringify(params), "succeeded", null, demoMediaUrl(t.previewKey, published), 0, createdBy,
             made, made, shot.id, t.version, "byteplus", "generate", t.approved ? "approved" : "", t.approved ? createdBy : null, t.approved ? made + 60_000 : null],
    });
  }
}
