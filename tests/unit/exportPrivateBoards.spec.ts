import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Exports (app/api/export: the takes CSV, the masters manifest, the JSON): an admin's export includes every member's private board, with one history line per private board
 * (owner, 15 Oct 2026: "Admin exports include private boards, with one audit line per private board per export"), ids and action only; a member's export never includes another
 * member's private board; another workspace has none. Real temporary databases; nothing is sent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-export-private-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const person = (id: string, role: "admin" | "member" = "member", owner = false) => ({ id, role, owner });
const user = (id: string, role: "admin" | "member" = "member", owner = false) => ({ id, email: `${id}@example.test`, name: id, role, owner, disabled: false, lastSeen: null, createdAt: 0 });
const ADMIN = person("u_admin", "admin", true), MATE1 = person("u_mate1"), MATE2 = person("u_mate2");

async function fixture(ws: TenantWorkspace) {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const board = (owner: string, id: string) => draft.mappedId("prj_wb_", ws.id, owner, id);
  const boards = { p1: board("u_mate1", "d1"), p2: board("u_mate2", "d2"), shared: board("u_mate1", "d3"), adminOwn: board("u_admin", "d4"), p3: board("u_mate1", "d5") };
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    for (const [id, name] of [[boards.p1, "Mate one"], [boards.p2, "Mate two"], [boards.shared, "Shared"], [boards.adminOwn, "Admin own"], [boards.p3, "Mate three"], ["prod_open", "Open production"]])
      await db.execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, name] });
    const draftRow = (owner: string, id: string, extra: Record<string, unknown>) => db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${owner}:${id}`, owner, id, id, JSON.stringify(extra)] });
    await draftRow("u_mate1", "d1", { productionProjectId: boards.p1 });
    await draftRow("u_mate2", "d2", { productionProjectId: boards.p2 });
    await draftRow("u_mate1", "d3", { productionProjectId: boards.shared, teamShared: true });
    await draftRow("u_admin", "d4", { productionProjectId: boards.adminOwn });
    await draftRow("u_mate1", "d5", { productionProjectId: boards.p3 });
    const take = (id: string, text: string, projectId: string | null, at: number) => db.execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id) VALUES(?,?,?,?,?,?,?,'image',?,0,'u_mate1',?)`,
      args: [id, "m", text, "{}", "succeeded", at, at, text, projectId] });
    await take(`g_p1_${run}`, "P1-TAKE", boards.p1, 10);
    await take(`g_p2_${run}`, "P2-TAKE", boards.p2, 20);
    await take(`g_sh_${run}`, "SHARED-TAKE", boards.shared, 30);
    await take(`g_ad_${run}`, "ADMINOWN-TAKE", boards.adminOwn, 40);
    await take(`g_op_${run}`, "OPEN-TAKE", "prod_open", 50);
    await take(`g_fr_${run}`, "FREE-TAKE", null, 60);
    /* Uploads: one used only by a private board's take (p1), one only by a shot of the take-less private board (p3), one only by a draft that never became a board, one by an ordinary production's take
       (shared work), one with no uploader. All uploaded by mate one except the last. */
    const upload = (id: string, uploader: string | null) => db.execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,uploader_id) VALUES(?,?,'image/png','png',1,'x','/x',0,?)", args: [id, `${id}-FILE.png`, uploader] });
    await upload("up_p1", "u_mate1"); await upload("up_p3", "u_mate1"); await upload("up_draft", "u_mate1"); await upload("up_open", "u_mate1"); await upload("up_null", null);
    await db.execute({ sql: "UPDATE generations SET params=? WHERE id=?", args: [JSON.stringify({ uploadId: "up_p1" }), `g_p1_${run}`] });
    await db.execute({ sql: "UPDATE generations SET params=? WHERE id=?", args: [JSON.stringify({ uploadId: "up_open" }), `g_op_${run}`] });
    await draftRow("u_mate1", "d9", { nodes: [{ id: "n1", uploadId: "up_draft" }] });
    /* Records that only NAME a private take or shot, in a workspace-wide row or an ordinary production's. */
    await db.execute({ sql: "INSERT INTO shot_presets(id,project_id,name,created_at,cover_gen_id) VALUES('preset_x',NULL,'A look',0,?)", args: [`g_p1_${run}`] });
    await db.execute({ sql: "INSERT INTO elements(id,project_id,name,created_at,updated_at,from_gen_id,from_shot_id) VALUES('el_x','prod_open','An element',0,0,?,'shot_p3')", args: [`g_p1_${run}`] });
    await db.execute({ sql: "INSERT INTO canvas_items(id,project_id,ref_id,text,created_at,updated_at) VALUES('ci_ref','prod_open',?,'a card',0,0)", args: [`g_p1_${run}`] });
    /* Rows that belong to boards but are not takes: a private board with a shot, a canvas card and a production and NO take (p3); notes, provenance and a client comment on a private take (p1); the same on an ordinary production. */
    await db.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u_mate1','m1@example.test','Mate','x','member',0)", args: [] });
    await db.execute({ sql: "INSERT INTO productions(id,name,created_at) VALUES('prodp3','P3-PRODUCTION',0)", args: [] });
    await db.execute({ sql: "UPDATE projects SET production_id='prodp3' WHERE id=?", args: [boards.p3] });
    const shot = (id: string, projectId: string, text: string) => db.execute({ sql: "INSERT INTO shots(id,project_id,title,description,created_at,updated_at) VALUES(?,?,?,?,0,0)", args: [id, projectId, text, text] });
    await shot("shot_p3", boards.p3, "P3-SHOT"); await shot("shot_op", "prod_open", "OPEN-SHOT");
    await db.execute({ sql: "INSERT INTO canvas_items(id,project_id,text,created_at,updated_at) VALUES('ci_p3',?,'P3-CANVAS',0,0)", args: [boards.p3] });
    await db.execute({ sql: "UPDATE shots SET setup=? WHERE id='shot_p3'", args: [JSON.stringify({ refs: [{ uploadId: "up_p3" }] })] });
    for (const [gen, tag] of [[`g_p1_${run}`, "P1"], [`g_op_${run}`, "OPEN"]] as const) {
      await db.execute({ sql: "INSERT INTO notes(id,gen_id,user_id,text,created_at) VALUES(?,?,'u_mate1',?,0)", args: [`n_${tag}`, gen, `${tag}-NOTE`] });
      await db.execute({ sql: "INSERT INTO review_notes(id,gen_id,share_id,guest,text,created_at) VALUES(?,?,'shr_x','guest',?,0)", args: [`rn_${tag}`, gen, `${tag}-REVIEWNOTE`] });
      await db.execute({ sql: "INSERT INTO take_provenance(take_id,recorded,created_at) VALUES(?,?,0)", args: [gen, JSON.stringify({ tag: `${tag}-PROV` })] });
    }
  }, { user: user("u_mate1") });
  return { tenant, database, boards };
}
const lines = (tenant: typeof import("../../lib/tenant"), database: typeof import("../../lib/db"), ws: TenantWorkspace) =>
  tenant.runInTenant(ws, async () => (await database.db().execute({ sql: "SELECT actor_id, action, target_id FROM security_audit WHERE action LIKE 'board.%' ORDER BY target_id", args: [] })).rows.map((r) => `${r.actor_id}:${r.action}:${r.target_id}`), { user: user("u_admin", "admin", true) });
const ids = (rows: { prompt: string }[]) => rows.map((r) => r.prompt).sort();

test("an admin's takes export includes every member's private board, with one history line per private board and none for the shared board or their own", async () => {
  const ws = workspace(`ex-a-${run}`);
  const { tenant, database, boards } = await fixture(ws);
  const { exportRows } = await import("../../lib/exportRows");
  const { rows } = await tenant.runInTenant(ws, () => exportRows(ADMIN), { user: user("u_admin", "admin", true) });
  expect(ids(rows)).toEqual(["ADMINOWN-TAKE", "FREE-TAKE", "OPEN-TAKE", "P1-TAKE", "P2-TAKE", "SHARED-TAKE"]);
  expect(await lines(tenant, database, ws), "one line per private board that is another member's: three (one has a shot and no take); the shared board and the admin's own: none").toEqual(
    [`u_admin:board.exported_by_admin:${boards.p1}`, `u_admin:board.exported_by_admin:${boards.p2}`, `u_admin:board.exported_by_admin:${boards.p3}`].sort());
  /* Ids and action only: the history holds no name, prompt or title. */
  const text = JSON.stringify(await lines(tenant, database, ws));
  expect(text).not.toMatch(/P1-TAKE|P2-TAKE|Mate one|Mate two/);
  /* An export is counted every time: the same export again soon after writes three NEW lines (no 15-minute rule for exports). */
  await tenant.runInTenant(ws, () => exportRows(ADMIN), { user: user("u_admin", "admin", true) });
  expect(await lines(tenant, database, ws)).toHaveLength(6);
  /* The board's maker reads it apart from a view: "exported", twice. */
  const { boardViews } = await import("../../lib/workbench/team-boards");
  const seen = await tenant.runInTenant(ws, () => boardViews(ws, "u_mate1"), { user: user("u_mate1") });
  expect(seen.map((v) => v.what)).toEqual(["exported", "exported", "exported", "exported"]);
  /* A normal look at the same board is still the 15-minute "opened" line, once. */
  const { mayReachProject } = await import("../../lib/draftProject");
  await tenant.runInTenant(ws, async () => { await mayReachProject(ADMIN, boards.p1, "read"); await mayReachProject(ADMIN, boards.p1, "read"); }, { user: user("u_admin", "admin", true) });
  expect((await lines(tenant, database, ws)).filter((l) => l.includes("opened_by_admin"))).toEqual([`u_admin:board.opened_by_admin:${boards.p1}`]);
});

const everything = (payload: unknown) => JSON.stringify(payload);
const PRIVATE_WORDS = ["P1-TAKE", "P1-NOTE", "P1-REVIEWNOTE", "P1-PROV", "Mate one", "P3-SHOT", "P3-CANVAS", "P3-PRODUCTION", "Mate three", "P2-TAKE", "Mate two"];
const OPEN_WORDS = ["OPEN-TAKE", "OPEN-SHOT", "OPEN-NOTE", "OPEN-REVIEWNOTE", "OPEN-PROV", "Open production", "FREE-TAKE", "SHARED-TAKE", "ADMINOWN-TAKE"];

test("the JSON export of an admin includes every private board with all its rows (name, production, shots, canvas, notes, provenance, takes), one line per board, a board with a shot and no take too", async () => {
  const ws = workspace(`ex-b-${run}`);
  const { tenant, database, boards } = await fixture(ws);
  const { workspaceExport } = await import("../../lib/workspaceExport");
  const payload = await tenant.runInTenant(ws, () => workspaceExport("u_admin", "u_admin@example.test", ADMIN), { user: user("u_admin", "admin", true) }) as unknown as { generations: { prompt: string }[] };
  expect(ids(payload.generations)).toEqual(["ADMINOWN-TAKE", "FREE-TAKE", "OPEN-TAKE", "P1-TAKE", "P2-TAKE", "SHARED-TAKE"]);
  for (const word of [...PRIVATE_WORDS, ...OPEN_WORDS]) expect(everything(payload), word).toContain(word);
  expect(await lines(tenant, database, ws), "p3 has a shot and no take: it still writes its line").toEqual(
    [`u_admin:board.exported_by_admin:${boards.p1}`, `u_admin:board.exported_by_admin:${boards.p2}`, `u_admin:board.exported_by_admin:${boards.p3}`].sort());
});

test("when a private board's line cannot be written, NOTHING of that board is exported: not its name, production, shots, canvas, notes, provenance or takes; everything else is", async () => {
  const ws = workspace(`ex-bd-${run}`);
  const { tenant, database } = await fixture(ws);
  const { workspaceExport } = await import("../../lib/workspaceExport");
  await tenant.runInTenant(ws, () => database.db().execute("CREATE TRIGGER ex_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT, 'history is down'); END"), { user: user("u_admin", "admin", true) });
  const payload = await tenant.runInTenant(ws, () => workspaceExport("u_admin", "u_admin@example.test", ADMIN), { user: user("u_admin", "admin", true) });
  const text = everything(payload);
  for (const word of PRIVATE_WORDS) expect(text, word).not.toContain(word);
  for (const word of OPEN_WORDS) expect(text, word).toContain(word);
  expect(await lines(tenant, database, ws)).toEqual([]);
});

test("a member's export never includes another member's private board, and writes no line", async () => {
  const ws = workspace(`ex-c-${run}`);
  const { tenant, database } = await fixture(ws);
  const { exportRows } = await import("../../lib/exportRows");
  const { workspaceExport } = await import("../../lib/workspaceExport");
  const mine = await tenant.runInTenant(ws, () => exportRows(MATE1), { user: user("u_mate1") });
  expect(ids(mine.rows), "own private board, shared, ordinary and unfiled; not the admin's or mate two's").toEqual(["FREE-TAKE", "OPEN-TAKE", "P1-TAKE", "SHARED-TAKE"]);
  const theirs = await tenant.runInTenant(ws, () => exportRows(MATE2), { user: user("u_mate2") });
  expect(ids(theirs.rows)).toEqual(["FREE-TAKE", "OPEN-TAKE", "P2-TAKE", "SHARED-TAKE"]);
  const json = await tenant.runInTenant(ws, () => workspaceExport("u_mate2", "u_mate2@example.test", MATE2), { user: user("u_mate2") }) as unknown as { generations: { prompt: string }[] };
  expect(ids(json.generations)).toEqual(["FREE-TAKE", "OPEN-TAKE", "P2-TAKE", "SHARED-TAKE"]);
  /* None of mate one's board (name, production, shots, canvas, notes, provenance) is in mate two's export; mate one's own export has all of it. */
  for (const word of ["P1-TAKE", "P1-NOTE", "P1-REVIEWNOTE", "P1-PROV", "Mate one", "P3-SHOT", "P3-CANVAS", "P3-PRODUCTION", "Mate three"]) expect(everything(json), word).not.toContain(word);
  for (const word of ["P2-TAKE", "Mate two", ...OPEN_WORDS.filter((w) => w !== "ADMINOWN-TAKE" && w !== "Admin own")]) expect(everything(json), word).toContain(word);
  const own = await tenant.runInTenant(ws, () => workspaceExport("u_mate1", "m1@example.test", MATE1), { user: user("u_mate1") });
  for (const word of ["P1-TAKE", "P1-NOTE", "P3-SHOT", "P3-CANVAS", "P3-PRODUCTION", "Mate three"]) expect(everything(own), word).toContain(word);
  for (const word of ["P2-TAKE", "Mate two"]) expect(everything(own), word).not.toContain(word);
  expect(await lines(tenant, database, ws)).toEqual([]);
});

test("no line, no export of that board: with the history down, the admin's export leaves the private boards out", async () => {
  const ws = workspace(`ex-d-${run}`);
  const { tenant, database } = await fixture(ws);
  const { exportRows } = await import("../../lib/exportRows");
  await tenant.runInTenant(ws, () => database.db().execute("CREATE TRIGGER ex_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT, 'history is down'); END"), { user: user("u_admin", "admin", true) });
  const { rows } = await tenant.runInTenant(ws, () => exportRows(ADMIN), { user: user("u_admin", "admin", true) });
  expect(ids(rows)).toEqual(["ADMINOWN-TAKE", "FREE-TAKE", "OPEN-TAKE", "SHARED-TAKE"]);
});

test("another workspace's export holds none of this workspace's takes, and writes no line", async () => {
  const ws = workspace(`ex-e-${run}`), other = workspace(`ex-e2-${run}`);
  const { tenant, database } = await fixture(ws);
  await tenant.runInTenant(other, async () => { await database.ready(); }, { user: user("u_admin", "admin", true) });
  const { exportRows } = await import("../../lib/exportRows");
  const { rows } = await tenant.runInTenant(other, () => exportRows(ADMIN), { user: user("u_admin", "admin", true) });
  expect(rows).toEqual([]);
  expect(await lines(tenant, database, other)).toEqual([]);
});

/* ── Uploads and id-only references ─────────────────────────────────────────────────────────────────────────────────────────────── */
const uploadIds = (payload: unknown) => ((payload as { uploads: { id: string }[] }).uploads).map((u) => u.id).sort();
const exportAs = async (tenant: typeof import("../../lib/tenant"), ws: TenantWorkspace, who: ReturnType<typeof person>, u: ReturnType<typeof user>) => {
  const { workspaceExport } = await import("../../lib/workspaceExport");
  return tenant.runInTenant(ws, () => workspaceExport(who.id, `${who.id}@example.test`, who), { user: u }) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

test("uploads: an admin's export carries those it may open and those a board it takes out uses; one used only by a board whose line failed, or by a draft that never became a board, stays", async () => {
  const wsA = workspace(`ex-u1-${run}`), wsB = workspace(`ex-u2-${run}`);
  const a = await fixture(wsA), b = await fixture(wsB);
  const ok = await exportAs(a.tenant, wsA, ADMIN, user("u_admin", "admin", true));
  expect(uploadIds(ok), "audited boards' uploads present; the unaudited draft's absent").toEqual(["up_null", "up_open", "up_p1", "up_p3"]);
  /* The history is down: no board's line is written, so no board goes out, and neither do the uploads only they use. */
  await b.tenant.runInTenant(wsB, () => b.database.db().execute("CREATE TRIGGER ex_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT, 'history is down'); END"), { user: user("u_admin", "admin", true) });
  const down = await exportAs(b.tenant, wsB, ADMIN, user("u_admin", "admin", true));
  expect(uploadIds(down)).toEqual(["up_null", "up_open"]);
  expect(JSON.stringify(down)).not.toMatch(/up_p1|up_p3|up_draft/);
});

test("uploads: a member's export carries what they may open and nothing only another member's private board uses; the maker's own export keeps their own, drafts' included", async () => {
  const ws = workspace(`ex-u3-${run}`);
  const { tenant } = await fixture(ws);
  expect(uploadIds(await exportAs(tenant, ws, MATE2, user("u_mate2")))).toEqual(["up_null", "up_open"]);
  expect(uploadIds(await exportAs(tenant, ws, MATE1, user("u_mate1")))).toEqual(["up_draft", "up_null", "up_open", "up_p1", "up_p3"]);
});

test("records that only name a private take, shot or board: a workspace-wide row stays with the reference emptied when that board stays out, and keeps it when the board goes out", async () => {
  const wsA = workspace(`ex-r1-${run}`), wsB = workspace(`ex-r2-${run}`);
  const a = await fixture(wsA), b = await fixture(wsB);
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  for (const [ws, boards] of [[wsA, a.boards], [wsB, b.boards]] as const)
    await platformDb().execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at,project_id,shot_id) VALUES(?,?,'image','x','m','succeeded',1,3,1,1,1,?,'shot_p3')", args: [`me_${ws.id}`, ws.id, boards.p1] });
  const refs = (p: Record<string, any>) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    preset: p.shot_presets.find((r: { id: string }) => r.id === "preset_x")?.cover_gen_id,
    fromGen: p.elements.find((r: { id: string }) => r.id === "el_x")?.from_gen_id, fromShot: p.elements.find((r: { id: string }) => r.id === "el_x")?.from_shot_id,
    card: p.canvas_items.find((r: { id: string }) => r.id === "ci_ref")?.ref_id,
    meter: p.meter_events.find((r: { id: string }) => r.id.startsWith("me_")),
  });
  const out = refs(await exportAs(a.tenant, wsA, ADMIN, user("u_admin", "admin", true)));
  expect(out, "the boards go out: the references stay").toMatchObject({ preset: `g_p1_${run}`, fromGen: `g_p1_${run}`, fromShot: "shot_p3", card: `g_p1_${run}` });
  expect(out.meter).toMatchObject({ project_id: a.boards.p1, shot_id: "shot_p3" });
  await b.tenant.runInTenant(wsB, () => b.database.db().execute("CREATE TRIGGER ex_no_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'board.%' BEGIN SELECT RAISE(ABORT, 'history is down'); END"), { user: user("u_admin", "admin", true) });
  const held = refs(await exportAs(b.tenant, wsB, ADMIN, user("u_admin", "admin", true)));
  expect(held, "the boards stay out: the rows stay (workspace-wide, an ordinary production's, the billing) with the reference emptied").toMatchObject({ preset: null, fromGen: null, fromShot: null, card: null });
  expect(held.meter).toMatchObject({ project_id: null, shot_id: null, billed_credits: 3 });
});
