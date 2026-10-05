import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Tenant separation for signed-out visitors (lead decisions 35 and 39), on local libSQL databases: a guest reads the
 * sample's title from the ONE workspace the platform owner named in /admin, only while Guest Home is on, and never
 * anything from another workspace. The site switches fail closed and leave the platform layer untouched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-s15-guest-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

test.describe.configure({ mode: "serial" });

type Ws = { id: string };
let alpha: Ws, beta: Ws, gamma: Ws, delta: Ws;

async function workspace(label: string): Promise<Ws> {
  const { createAccount, createWorkspace } = await import("../../lib/platform");
  const owner = await createAccount(`${label}@example.test`, label, "not-a-real-hash");
  return createWorkspace({ name: label, owner });
}
/** The mark stream 12's build action writes (lib/demo/sample.ts); a hand-written row of any other shape reads as no sample. */
const markFor = (projectId: string, name: string, draftId = "draft_none") => JSON.stringify({ version: 1, projectId, name, draftOwner: "someone", draftId, markedBy: "someone", markedAt: Date.now() });
/** Writes a project, and optionally the sample's mark, into one workspace's own database. */
async function seed(ws: Ws, project: { id: string; name: string } | null, sampleProjectId?: string) {
  const { getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const tenant = (await getWorkspace(ws.id))!;
  await runInTenant(tenant, async () => {
    await ready();
    if (project) await db().execute({ sql: `INSERT INTO projects (id, name, description, created_at) VALUES (?,?,?,?)`, args: [project.id, project.name, "", Date.now()] });
    if (sampleProjectId) await db().execute({ sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('sampleProduction', ?, 'builder', ?)`, args: [markFor(sampleProjectId, project?.name ?? "A film"), Date.now()] });
  });
}
const PRICES = [43, 43, 7];
const MODELS = ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-5-260628", "fal-ai/kling-video/v3/standard"];
/** A FINISHED production in one workspace the way its owner leaves it: a saved draft with a cast and a cut over three shots, a take on each, and the ledger's record of what each cost. Neutral words only. */
async function finished(ws: Ws, name = "A fixture film", approve = 2) {
  const { getWorkspace, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { saveDraft } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const tenant = (await getWorkspace(ws.id))!;
  await runInTenant(tenant, async () => {
    await ready();
    const base = { ...newProject(name), id: "fixture-film", aspect: "16:9", fps: 24, brief: "A short film about a walk to a sculpture." };
    const first = await saveDraft("someone", base, 0);
    const production = first.productionProjectId!;
    const takes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const shot = `shot_t_${i}`, take = `gen_t_${ws.id}_${i}`, at = Date.now() - 600_000;
      await db().execute({ sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty) VALUES (?,?,?,?,?,?,'open',?,?,?,?,5,'{}','[]','render',1)`, args: [shot, production, "", `C${i + 1}`, `Shot ${i + 1}`, "", i, "someone", at, at] });
      await db().execute({ sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted) VALUES (?,?,?,'video',?,?,?,'succeeded','/fixtures/clip.mp4',0,?,?,?,1,'byteplus','generate',?,?,?,0)`, args: [take, production, shot, MODELS[i], `Take ${i + 1}`, JSON.stringify({ duration: 5, resolution: "1080p" }), "someone", at + i, at + i, i < approve ? "approved" : "", i < approve ? "someone" : null, i < approve ? at + i + 1000 : null] });
      await platformDb().execute({ sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES (?,?,?,?,'video','byteplus',?,'succeeded',0.5,?,1,?,?,?)`, args: [take, ws.id, production, shot, MODELS[i], PRICES[i], "someone", at + i, at + i] });
      takes.push(take);
    }
    const project = {
      ...base, productionProjectId: production,
      assets: takes.map((take, i) => ({ id: `asset-${i}`, name: `Take ${i + 1}`, kind: "video" as const, category: "Shot", url: `/api/media/${take}`, description: "", prompt: "", status: i < approve ? "Selected" as const : "Draft" as const, locked: false, version: 1, refs: [], generationId: take })),
      shots: takes.map((_, i) => ({ id: `cut-${i}`, name: `Shot ${i + 1}`, assetId: `asset-${i}`, duration: 120, sourceIn: 0, note: "" })),
      production: { cast: { entries: [{ id: "cast-lead", name: "Lead", kind: "character" as const, description: "ivory suit, short dark bob", prompt: "", takes: [] }] } },
    };
    await saveDraft("someone", project, first.revision);
    await db().execute({ sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('sampleProduction', ?, 'builder', ?)`, args: [markFor(production, name, "fixture-film"), Date.now()] });
  });
}
async function site(patch: Record<string, unknown>) {
  const { writeSite } = await import("../../lib/site/settings.server");
  return writeSite(patch, "owner");
}

test.beforeAll(async () => {
  alpha = await workspace("alpha");
  beta = await workspace("beta");
  gamma = await workspace("gamma");
  await finished(alpha, "Alpha sample film");
  await seed(alpha, { id: "proj_alpha_private", name: "Alpha private project" });
  await finished(beta, "Beta sample film");
  /* Gamma holds a mark for a production that exists only in Beta's database. */
  await seed(gamma, null, "proj_beta_sample");
  delta = await workspace("delta");
  await finished(delta);
});

test("the switches are off by default and an unreadable row stays off", async () => {
  const { readSite } = await import("../../lib/site/settings.server");
  expect(await readSite()).toEqual({ openSignup: false, guestHome: false, guestWorkspace: null });
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', '{not json', 0, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [] });
  expect(await readSite()).toEqual({ openSignup: false, guestHome: false, guestWorkspace: null });
});

test("guest Home off: nothing is read for a guest, whatever workspace is named", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: false, guestWorkspace: alpha.id });
  expect(await guestSample()).toBeNull();
  await site({ guestHome: true, guestWorkspace: null });
  expect(await guestSample()).toBeNull();
});

test("guest Home on: only the named workspace's sample title, never another workspace's", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: true, guestWorkspace: alpha.id });
  expect((await guestSample())?.title).toBe("Alpha sample film");
  await site({ guestWorkspace: beta.id });
  expect((await guestSample())?.title).toBe("Beta sample film");
  /* A setting pointing at another workspace's project id finds nothing: each workspace is its own database. */
  await site({ guestWorkspace: gamma.id });
  expect(await guestSample()).toBeNull();
});

test("the answer holds the title and the board's words only: no ids, people, vendor figures or settings", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: true, guestWorkspace: alpha.id });
  const sample = await guestSample();
  expect(Object.keys(sample ?? {})).toEqual(["title", "board"]);
  expect(JSON.stringify(sample)).not.toMatch(/proj_|someone|builder|private/);
});

test("a finished sample: its plan at the recorded prices, its shots, cast and cut, read from the one named workspace", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: true, guestWorkspace: delta.id });
  const sample = await guestSample();
  expect(sample?.title).toBe("A fixture film");
  const board = sample!.board!;
  expect(board.brief).toBe("A short film about a walk to a sculpture.");
  expect(board.frame).toBe("16:9 · 24 fps · 15 s");
  expect(board.plan).toMatchObject({ heading: "Make 3 shots · 93 cr", total: 93, fixesMost: 186, steps: [
    { title: "Shot 1", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43 },
    { title: "Shot 2", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43 },
    { title: "Shot 3", meta: expect.stringContaining("Kling"), credits: 7 },
  ] });
  expect(board.shots.map((s) => [s.name, s.start, s.seconds, s.approved])).toEqual([["Shot 1", "0:00", 5, true], ["Shot 2", "0:05", 5, true], ["Shot 3", "0:10", 5, false]]);
  expect(board.cast).toEqual(["Lead · ivory suit, short dark bob"]);
  expect(board.cut.line).toBe("2 approved takes · 0:10 · Shot 3 waits for review");
  expect(board.review?.name).toBe("Shot 3");
  expect(board.deliver.every((d) => d.pending)).toBe(true);
  /* Nothing private rides along: no id, person, vendor figure or consent. */
  expect(JSON.stringify(sample)).not.toMatch(/someone|prj_|gen_t_|shot_t_|\bws_|cost|usd|consent|\bSH\d/i);
  /* Another workspace's guest read never carries this film. */
  await site({ guestWorkspace: alpha.id });
  expect(JSON.stringify(await guestSample())).not.toContain("fixture");
});

test("a hidden or hand-written mark reads as no sample", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  const { getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await site({ guestHome: true, guestWorkspace: delta.id });
  const tenant = (await getWorkspace(delta.id))!;
  const original = await runInTenant(tenant, async () => String((await db().execute({ sql: `SELECT value FROM settings WHERE key = 'sampleProduction'` })).rows[0].value));
  const put = (value: string) => runInTenant(tenant, () => db().execute({ sql: `UPDATE settings SET value = ? WHERE key = 'sampleProduction'`, args: [value] }));
  await put(JSON.stringify({ ...JSON.parse(original), hiddenAt: Date.now() }));
  expect(await guestSample()).toBeNull();
  await put(JSON.stringify({ projectId: "x" }));
  expect(await guestSample()).toBeNull();
  await put(original);
  expect((await guestSample())?.title).toBe("A fixture film");
});

test("a workspace that is deleted after it was named is no longer read", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  const { platformDb } = await import("../../lib/platform");
  await site({ guestHome: true, guestWorkspace: beta.id });
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = ? WHERE id = ?`, args: [Date.now(), beta.id] });
  expect(await guestSample()).toBeNull();
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = NULL WHERE id = ?`, args: [beta.id] });
});

test("only a live workspace on this deployment can be named", async () => {
  const { SiteSettingsError } = await import("../../lib/site/settings.server");
  await expect(site({ guestWorkspace: "ws_not_here" })).rejects.toBeInstanceOf(SiteSettingsError);
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = ? WHERE id = ?`, args: [Date.now(), gamma.id] });
  await expect(site({ guestWorkspace: gamma.id })).rejects.toBeInstanceOf(SiteSettingsError);
});

test("the guest sample is never the house workspace", async () => {
  const { SiteSettingsError } = await import("../../lib/site/settings.server");
  const { platformDb } = await import("../../lib/platform");
  const house = await workspace("house");
  await platformDb().execute({ sql: `UPDATE workspaces SET legacy = 1 WHERE id = ?`, args: [house.id] });
  try {
    await expect(site({ guestWorkspace: house.id })).rejects.toBeInstanceOf(SiteSettingsError);
  } finally {
    await platformDb().execute({ sql: `UPDATE workspaces SET legacy = 0 WHERE id = ?`, args: [house.id] });
  }
});

test("the site row never changes the platform layer (plans, caps, defaults)", async () => {
  const { platformLayerState } = await import("../../lib/platform");
  await site({ openSignup: true, guestHome: true, guestWorkspace: alpha.id });
  const layer = await platformLayerState();
  expect(layer.stored).not.toContain("site" as never);
  expect(Object.keys(layer.value)).not.toContain("site");
  await site({ openSignup: false, guestHome: false, guestWorkspace: null });
});

test("Request access keeps what they make and their brief in the request the owner reads", async () => {
  const { POST } = await import("../../app/api/access-request/route");
  const { NextRequest } = await import("next/server.js");
  const req = new NextRequest("http://localhost/api/access-request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ name: "A Person", email: "person@example.test", make: "Ad films", brief: "A short film about rain.", note: "From guest Home", company: "" }),
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: `SELECT name, note FROM access_requests WHERE email = ?`, args: ["person@example.test"] })).rows[0] as unknown as { name: string; note: string };
  expect(row.name).toBe("A Person");
  expect(row.note).toBe("From guest Home\nWhat they make: Ad films\nTheir brief: A short film about rain.");
});
