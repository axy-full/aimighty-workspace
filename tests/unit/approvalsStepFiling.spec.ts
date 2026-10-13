import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * An admin's render of another member's step files into THAT step's own project, resolved by the server from a step the admin claimed and has not sent (owner, 13 Oct;
 * lib/atomikAccess.ts claimedStepFiling, lib/generationAdmission.ts): the production's caps and the 200 cr line apply as on any render there, the take is not Unfiled, the
 * admin never names or reads the board, and a step that is not theirs to render is gone. Real temporary databases; the engine is mocked; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-step-filing-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: true }) as TenantWorkspace;
const user = (id: string, role: "admin" | "member" = "member") => ({ id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0 });
const as = (id: string, role: "admin" | "member" = "member", token = false) => ({ user: user(id, role), ...(token ? { token: { id: `tok_${id}`, name: "agent", scope: "render" as const, capUsd: null } } : {}) });

test("the render files into the step's own project, under its cap, for the admin who claimed it and for nobody else", async () => {
  const ws = workspace(`sf-${run}`);
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await platformDb().execute("CREATE TABLE IF NOT EXISTS generation_reservations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token_id TEXT)");
  await alignLedgerUnit();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_sf_${run}`, ws.id, 5000, "Test", Date.now()] });
  const board = draft.mappedId("prj_wb_", ws.id, "u_member", "d1");
  await tenant.runInTenant(ws, async () => {
    await database.ready(); await workbenchReady();
    const db = database.db();
    await db.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "The member's board"] });
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: ["u_member:d1", "u_member", "d1", "d1", JSON.stringify({ ...newProject("d1"), id: "d1", productionProjectId: board })] });
    await db.execute({ sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES('ach_s',?,'Chat','waiting','u_member',1,1)", args: [board] });
    await db.execute({ sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES('ma','ach_s','assistant','A plan',1)", args: [] });
    for (const [id, status, claimedBy] of [["st_run", "running", "u_admin"], ["st_prop", "proposed", null], ["st_other", "running", "u_admin2"]] as const)
      await db.execute({ sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,status,claimed_by,est_cost_usd,created_at,updated_at) VALUES(?,?,?,0,'video','A step','A tree in rain','grok-imagine-video',?,?,1,1,1)", args: [id, "ach_s", "ma", status, claimedBy] });
  }, { user: user("u_member") });
  const body = (extra: Record<string, unknown> = {}) => ({ model: "grok-imagine-video", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, ...extra });
  const ask = (actor: ReturnType<typeof as>, extra: Record<string, unknown>) =>
    tenant.runInTenant(ws, async () => { await database.ready(); const r = await prepareGeneration(body(extra), actor as never); return r.ok ? ({ ok: true, project: (r.value.request as { projectId?: string }).projectId, credits: r.value.quote.estimatedCredits }) : ({ ok: false, status: r.status, body: r.body }); }, { user: actor.user, token: actor.token as never });
  const money = () => tenant.runInTenant(ws, async () => ({
    held: Number((await database.db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meter: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
    reservations: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n),
  }), { user: user("u_member") });
  const before = await money();
  const gone = { ok: false, status: 404, body: { error: "That step is gone." } };
  /* The admin who claimed it: quoted in the member's own project, which the request never names. */
  const quoted = await ask(as("u_admin", "admin"), { atomikStepId: "st_run" });
  expect(quoted).toMatchObject({ ok: true, project: board });
  /* A project named by the client is not what files it: the step's own wins. */
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_run", projectId: "prod_elsewhere" })).toMatchObject({ ok: true, project: board });
  /* Without the step the board is still a missing project to the admin. */
  expect(await ask(as("u_admin", "admin"), { projectId: board })).toEqual({ ok: false, status: 404, body: { error: "No such project." } });
  /* Not theirs to render: another admin's claim, a step nobody claimed, an unknown step, a member, a token (its person's own claim aside). */
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_prop" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_other" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: "st_nothing" })).toEqual(gone);
  expect(await ask(as("u_mate"), { atomikStepId: "st_run" })).toEqual(gone);
  expect(await ask(as("u_admin", "admin"), { atomikStepId: { $ne: 1 } })).toEqual(gone);
  /* The production's cap applies to it as to any render there: over the cap, it is refused, and nothing is held, reserved or charged. */
  await tenant.runInTenant(ws, () => database.db().execute({ sql: "UPDATE projects SET cap_credits=? WHERE id=?", args: [Math.max(1, Number((quoted as { credits: number }).credits) - 1), board] }), { user: user("u_member") });
  const capped = await ask(as("u_admin", "admin"), { atomikStepId: "st_run" });
  expect(capped.ok, JSON.stringify(capped)).toBe(false);
  expect(JSON.stringify(capped)).not.toContain("That step is gone");
  expect(await money(), "nothing was held, reserved or metered").toEqual(before);
});
