import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Studio's first run: "Explore the starter production" (lib/starter.ts,
 * lib/workbench/starter-draft.ts, POST /api/workbench/projects › starter).
 *
 * The starter is sample takes on the platform's own previews. Seeding it
 * sends no request to any engine and writes no charge. Nothing lands in the
 * platform record (no meter events, no billing-ledger rows, no grants), and
 * the takes carry no spend in any total a cap, a statement or a usage screen
 * reads. Pressing the button again, or twice at once, makes one production
 * per workspace and one draft per person. Each workspace's starter lives in
 * that workspace's own database.
 *
 * No paid call: every outbound request fails the test.
 */
const dir = mkdtempSync(path.join(tmpdir(), "starter-production-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "starter-production-unit-keyring-not-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const originalFetch = globalThis.fetch;
const outbound: string[] = [];
test.beforeEach(() => {
  outbound.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    outbound.push(String(input instanceof Request ? input.url : input));
    throw new Error("Unexpected external request in test");
  };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

/** One workspace of this run, with its own database file. */
async function workspace(name: string, planId: string | null = null) {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  await platformReady();
  const id = `starter-${name}-${Date.now().toString(36)}`;
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,plan_id) VALUES(?,?,?,?,1,'owner',0,0,?)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`, planId],
  });
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

/** Row counts of every table in a database: the whole of what a step wrote, in one diff. */
async function counts(client: { execute: (sql: string) => Promise<{ rows: unknown[] }> }) {
  const tables = (await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)).rows as unknown as { name: string }[];
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = Number(((await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`)).rows[0] as { n: number }).n);
  return out;
}
function diff(before: Record<string, number>, after: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[name] ?? 0) - (before[name] ?? 0);
    if (d) out[name] = d;
  }
  return out;
}

/** Everything the seed reads first (the workspace's schema, the platform layer and its previews), so the diff is the seed's own writes. */
async function warm() {
  const { ready } = await import("../../lib/db");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { getPlatformLayer, listPlatformAssets, platformReady } = await import("../../lib/platform");
  const { archiveReady } = await import("../../lib/archive");
  await ready(); await workbenchReady(); await archiveReady(); await platformReady();
  await getPlatformLayer(); await listPlatformAssets("previews/");
}

test("seeding sends nothing to any engine and writes no charge: the platform record is untouched and every take is spend-free", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("charge"), async () => {
    const { db } = await import("../../lib/db");
    const { platformDb } = await import("../../lib/platform");
    const { seedStarterProduction } = await import("../../lib/starter");
    const { DEMO_TAKES, isDemoMediaUrl } = await import("../../lib/demoProduction");
    const { billedCreditsSum } = await import("../../lib/creditSql");
    const { spentBy } = await import("../../lib/caps");
    const { renderSpendByPayer } = await import("../../lib/reconcile");
    await warm();
    const platformBefore = await counts(platformDb());
    const tenantBefore = await counts(db());

    const made = await seedStarterProduction("owner");
    expect(made?.projectId).toMatch(/^prj_/);

    // Nothing left the process: no engine, no storage, no vendor.
    expect(outbound).toEqual([]);
    // The platform record — the meter, the billing ledger, grants, top-ups, the dispatch queue — is exactly as it was.
    expect(diff(platformBefore, await counts(platformDb()))).toEqual({});
    // The workspace gained one production and its contents, and nothing else (no spend rows, no runs, no queued work).
    expect(diff(tenantBefore, await counts(db()))).toEqual({ productions: 1, projects: 1, cast_members: 2, shots: 3, generations: DEMO_TAKES.length });

    const takes = (await db().execute({ sql: `SELECT status, ark_task_id, cost_usd, refine_cost_usd, stored_url, params FROM generations WHERE project_id = ?`, args: [made!.projectId] })).rows as unknown as { status: string; ark_task_id: string | null; cost_usd: number | null; refine_cost_usd: number | null; stored_url: string; params: string }[];
    expect(takes).toHaveLength(DEMO_TAKES.length);
    for (const take of takes) {
      // Finished samples, never a job an engine is working on or a recovery sweep would ask an engine about.
      expect(take.status).toBe("succeeded");
      expect(take.ark_task_id).toBeNull();
      expect(isDemoMediaUrl(take.stored_url)).toBe(true);
      expect(take.cost_usd).toBe(0);
      expect(take.refine_cost_usd).toBeNull();
      // The demo's price is kept for display, outside every spend column.
      const params = JSON.parse(take.params) as { demo?: boolean; demoCostUsd?: number };
      expect(params.demo).toBe(true);
      expect(params.demoCostUsd).toBeGreaterThan(0);
    }
    // Every figure that bills or caps reads zero.
    const spend = (await db().execute(`SELECT COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS usd, ${billedCreditsSum()} AS credits FROM generations`)).rows[0] as unknown as { usd: number; credits: number };
    expect(Number(spend.usd)).toBe(0);
    expect(Number(spend.credits)).toBe(0);
    expect((await spentBy("project_id", [made!.projectId])).get(made!.projectId)).toEqual({ usd: 0, credits: 0 });
    expect((await renderSpendByPayer()).reduce((n, r) => n + r.usd, 0)).toBe(0);
  });
});

test("a second press, or three at once, makes one starter production; the seed never leaves half of one", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("once"), async () => {
    const { db } = await import("../../lib/db");
    const { seedStarterProduction, starterProductionId } = await import("../../lib/starter");
    const { DEMO_TAKES } = await import("../../lib/demoProduction");
    await warm();
    const racing = await Promise.all([seedStarterProduction("owner"), seedStarterProduction("owner"), seedStarterProduction("teammate")]);
    expect(racing.filter(Boolean)).toHaveLength(1);
    expect(await seedStarterProduction("owner")).toBeNull();
    const starters = (await db().execute(`SELECT id, production_id FROM projects WHERE starter = 1`)).rows;
    expect(starters).toHaveLength(1);
    expect(String(starters[0].id)).toBe(await starterProductionId());
    // A production of its own, on the Productions board.
    expect((await db().execute({ sql: `SELECT id FROM productions WHERE id = ?`, args: [starters[0].production_id] })).rows).toHaveLength(1);
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM generations`)).rows[0].n)).toBe(DEMO_TAKES.length);
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM shots`)).rows[0].n)).toBe(3);
    expect(outbound).toEqual([]);
  });
});

test("each person gets one draft of the starter: presses in parallel open the same draft, a teammate gets their own of the same production", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await workspace("drafts");
  await runInTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    const { openStarterDraft, starterDraftId } = await import("../../lib/workbench/starter-draft");
    const { readDraft } = await import("../../lib/workbench/records");
    await warm();
    const [a, b, c] = await Promise.all([openStarterDraft("owner"), openStarterDraft("owner"), openStarterDraft("owner")]);
    expect(new Set([a.project.id, b.project.id, c.project.id]).size).toBe(1);
    expect([a, b, c].filter((r) => r.created)).toHaveLength(1);
    expect([a, b, c].filter((r) => r.seeded)).toHaveLength(1);
    const productionId = a.project.productionProjectId!;
    expect(a.project.id).toBe(starterDraftId(ws.id, "owner", productionId));

    const again = await openStarterDraft("owner");
    expect(again).toMatchObject({ created: false, seeded: false, revision: 1 });
    expect(again.project.id).toBe(a.project.id);

    const theirs = await openStarterDraft("teammate");
    expect(theirs.created).toBe(true);
    expect(theirs.project.id).not.toBe(a.project.id);
    expect(theirs.project.productionProjectId).toBe(productionId);

    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM projects WHERE starter = 1`)).rows[0].n)).toBe(1);
    const drafts = (await db().execute(`SELECT owner, project_id, revision FROM workbench_projects ORDER BY owner`)).rows as unknown as { owner: string; project_id: string; revision: number }[];
    expect(drafts.map((d) => [d.owner, d.project_id, Number(d.revision)])).toEqual([["owner", a.project.id, 1], ["teammate", theirs.project.id, 1]]);

    // The draft is the production: its Rig shots are the production's shots, so a render files its take under the same shot.
    const saved = (await readDraft("owner", a.project.id))!;
    const shots = (await db().execute({ sql: `SELECT id FROM shots WHERE project_id = ? ORDER BY position`, args: [productionId] })).rows.map((r) => String(r.id));
    expect(Object.values(saved.project.shotMappings ?? {}).sort()).toEqual([...shots].sort());
    expect(saved.project.nodes.map((n) => saved.project.shotMappings?.[n.id])).toEqual(shots);
    expect(outbound).toEqual([]);
  });
});

test("the starter is the workspace's own: another workspace's database is untouched, and each gets its own", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const [one, two] = [await workspace("tenant-one"), await workspace("tenant-two")];
  const first = await runInTenant(one, async () => { await warm(); const { openStarterDraft } = await import("../../lib/workbench/starter-draft"); return openStarterDraft("owner"); });
  await runInTenant(two, async () => {
    const { db } = await import("../../lib/db");
    await warm();
    // Seeding the first workspace wrote nothing here.
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM projects`)).rows[0].n)).toBe(0);
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM generations`)).rows[0].n)).toBe(0);
    const { openStarterDraft } = await import("../../lib/workbench/starter-draft");
    const second = await openStarterDraft("owner");
    // The same person in another workspace: another production, another draft.
    expect(second.project.productionProjectId).not.toBe(first.project.productionProjectId);
    expect(second.project.id).not.toBe(first.project.id);
    expect(Number((await db().execute(`SELECT COUNT(*) AS n FROM projects WHERE starter = 1`)).rows[0].n)).toBe(1);
  });
});

test("the starter never uses up an Invite plan's one production", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(await workspace("invite", "invite"), async () => {
    const { openStarterDraft } = await import("../../lib/workbench/starter-draft");
    const { linkProduction } = await import("../../lib/workbench/records");
    const { newProject } = await import("../../lib/workbench/studio");
    await warm();
    await openStarterDraft("owner");
    // The plan's one production is still free after exploring the starter…
    await expect(linkProduction("owner", newProject("My first production"))).resolves.toMatch(/^prj_wb_/);
    // …and the ceiling still holds for the next one.
    await expect(linkProduction("owner", newProject("A second production"))).rejects.toThrow();
  });
});

test("the draft maps the production faithfully: shots to Rig shots, the approved take on its shot and in the cut, the cast, the brief — and it saves", async () => {
  const { starterDraft } = await import("../../lib/workbench/starter-draft");
  const { saveSchema } = await import("../../lib/workbench/studio-schema");
  const source = {
    production: { id: "prj_1", name: "Starter production", description: "Three shots to render against." },
    shots: [
      { id: "shot_a", code: "SH010", title: "The city, first light", description: "A quiet street at dawn.", planned: 5 },
      { id: "shot_b", code: "SH020", title: "", description: "@Mara crosses the street.", planned: null },
    ],
    cast: [{ name: "Mara", kind: "character", description: "A courier." }, { name: "Mule", kind: "prop", description: "A cargo bicycle." }],
    takes: [
      { id: "gen_1", shotId: "shot_a", version: 1, prompt: "wide", approved: false, createdAt: 1 },
      { id: "gen_2", shotId: "shot_a", version: 2, prompt: "push", approved: false, createdAt: 2 },
      { id: "gen_3", shotId: "shot_b", version: 1, prompt: "track", approved: true, createdAt: 3 },
      { id: "gen_4", shotId: "shot_b", version: 2, prompt: "handheld", approved: false, createdAt: 4 },
    ],
  };
  const { project, shotOf } = starterDraft("starter-abc", source, "2026-09-27T00:00:00.000Z");
  expect(project).toMatchObject({ id: "starter-abc", name: "Starter production", productionProjectId: "prj_1", brief: "A quiet street at dawn. @Mara crosses the street." });
  expect(project.nodes.map((n) => [n.id, n.type, n.title, n.text, n.status ?? null])).toEqual([
    ["node-shot-01", "scene", "The city, first light", "A quiet street at dawn.", null],
    ["node-shot-02", "scene", "SH020", "@Mara crosses the street.", "approved"],
  ]);
  expect(shotOf).toEqual({ "node-shot-01": "shot_a", "node-shot-02": "shot_b" });
  // A shot's picture is its approved take, else its newest.
  expect(project.nodes.map((n) => project.assets.find((a) => a.id === n.assetId)?.generationId)).toEqual(["gen_2", "gen_3"]);
  for (const asset of project.assets) expect(asset.url).toBe(`/api/media/${asset.generationId}`);
  // The cut holds a clip only where a take is approved, so Up next is the first shot still to render.
  expect(project.shots.map((s) => [s.name, s.assetId ? project.assets.find((a) => a.id === s.assetId)?.generationId : ""])).toEqual([["SH010 — The city, first light", ""], ["SH020 — SH020", "gen_3"]]);
  expect(project.production?.cast?.entries.map((e) => [e.name, e.kind, e.category])).toEqual([["Mara", "character", "character"], ["Mule", "element", "prop"]]);
  // It is a draft the save route accepts as it is.
  const parsed = saveSchema.safeParse({ project, revision: 0 });
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
});
