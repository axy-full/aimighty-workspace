import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/*
 * The platform console's server half (lib/platformAudit.ts, lib/platformConsole.server.ts, lib/platformFailedSaves.ts) on real
 * platform and workspace databases in a temp directory: every change the owner makes from the console writes its audit line in
 * the same transaction as the change; a refused change writes none; a line holds ids and checked values only; the reads that
 * cross workspaces (failed saves) read each workspace in its own database and a retry never reaches another workspace's render.
 * Nothing renders, nothing is billed, no engine is called.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-platform-console-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

const run = Math.random().toString(36).slice(2, 8);
const OWNER = { email: `console_owner-${run}@example.com`, name: "Pat Platform" };
const A = { email: `ada-${run}@example.com`, name: "Ada Maker" };
const B = { email: `bo-${run}@example.com`, name: "Bo Maker" };
const password = "Unique-studio-password-43";

async function setup() {
  const { hashPassword } = await import("../../lib/auth");
  const { createAccount, addMember } = await import("../../lib/platform");
  const { requestWorkspace, resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const owner = await createAccount(OWNER.email, OWNER.name, hashPassword(password));
  const a = await createAccount(A.email, A.name, hashPassword(password));
  const b = await createAccount(B.email, B.name, hashPassword(password));
  const wsA = (await resumeWorkspace(await requestWorkspace({ owner: a, name: `Alpha ${run}` }), a.id)).workspace!;
  const wsB = (await resumeWorkspace(await requestWorkspace({ owner: b, name: `Beta ${run}` }), b.id)).workspace!;
  await addMember(wsA, b, "member");
  return { owner, a, b, wsA, wsB };
}
let made: ReturnType<typeof setup> | null = null;
const fixture = () => (made ??= setup());

const lines = async (where = "1=1", args: (string | number)[] = []) => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT * FROM platform_audit WHERE ${where} ORDER BY created_at, id`, args });
  return rs.rows.map((r) => ({ action: String(r.action), actor: String(r.actor_id), target: r.target_id == null ? null : String(r.target_id), workspace: r.workspace_id == null ? null : String(r.workspace_id), details: JSON.parse(String(r.details)) as Record<string, unknown> }));
};

test("Grant credits: the credits and their audit line commit together, and a refused grant leaves no line", async () => {
  const { owner, wsA } = await fixture();
  const { grantCredits, creditsGranted } = await import("../../lib/platform");
  const before = await creditsGranted(wsA.id);
  await grantCredits(wsA.id, 25, "Goodwill", owner.id, "manual", { actorId: owner.id });
  expect(await creditsGranted(wsA.id)).toBe(before + 25);
  expect(await lines("workspace_id = ?", [wsA.id])).toEqual([{ action: "credits.granted", actor: owner.id, target: wsA.id, workspace: wsA.id, details: { credits: 25, kind: "manual" } }]);
  /* A take-back is a line too, with its sign. */
  await grantCredits(wsA.id, -5, "Correction", owner.id, "manual", { actorId: owner.id });
  expect((await lines("workspace_id = ?", [wsA.id])).at(-1)?.details).toEqual({ credits: -5, kind: "manual" });
  /* The house workspace is never given credits: refused whole, before anything is written. */
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  const total = (await lines()).length;
  await expect(grantCredits(HOUSE_WORKSPACE_ID, 10, "No", owner.id, "manual", { actorId: owner.id })).rejects.toThrow();
  expect((await lines()).length).toBe(total);
});

test("Pause and Resume: each writes its line with the change; an unknown workspace changes and writes nothing", async () => {
  const { owner, wsB } = await fixture();
  const { setWorkspaceSuspended, getWorkspace } = await import("../../lib/platform");
  await setWorkspaceSuspended(wsB.id, true, "Check", { actorId: owner.id });
  expect((await getWorkspace(wsB.id))?.suspendedAt).not.toBeNull();
  await setWorkspaceSuspended(wsB.id, false, null, { actorId: owner.id });
  expect((await getWorkspace(wsB.id))?.suspendedAt ?? null).toBeNull();
  expect((await lines("workspace_id = ?", [wsB.id])).map((l) => l.action)).toEqual(["workspace.paused", "workspace.resumed"]);
  const total = (await lines()).length;
  await setWorkspaceSuspended("ws_missing", true, "x", { actorId: owner.id });
  expect((await lines()).length).toBe(total);
  /* Called without an actor (the heartbeat, a test): the change is as it always was, no line. */
  await setWorkspaceSuspended(wsB.id, true, "System", undefined);
  await setWorkspaceSuspended(wsB.id, false, null);
  expect((await lines()).length).toBe(total);
});

test("Public site and the platform layer: a change by a person writes which switch and the value it was set to, never more", async () => {
  const { owner, wsA } = await fixture();
  const { writeSite, readSite } = await import("../../lib/site/settings.server");
  const { setPlatformLayer, resetPlatformLayer } = await import("../../lib/platform");
  const start = (await lines()).length;
  await writeSite({ openSignup: true, visitorPages: false }, owner.id);
  await writeSite({ guestWorkspace: wsA.id }, owner.id);
  await writeSite({ guestWorkspace: null, openSignup: false }, owner.id);
  expect((await readSite()).openSignup).toBe(false);
  const site = (await lines("action = 'site.changed'")).slice(-3).map((l) => l.details);
  expect(site).toEqual([{ openSignup: true, visitorPages: false }, { guestWorkspace: "set" }, { openSignup: false, guestWorkspace: "cleared" }]);
  /* The sample's workspace id is not in the line; a switch not in the patch is not either. */
  expect(JSON.stringify(site)).not.toContain(wsA.id);
  await writeSite({ guestHome: false }, null);
  expect((await lines("action = 'site.changed'")).length).toBe(3);
  await setPlatformLayer("caps", { warnPct: 70 }, owner.id);
  await resetPlatformLayer("caps", owner.id);
  expect((await lines()).slice(start).filter((l) => l.action.startsWith("layer.")).map((l) => [l.action, l.details])).toEqual([["layer.saved", { part: "caps" }], ["layer.reset", { part: "caps" }]]);
});

test("a line is append-only and holds checked fields only: no free text, no address, no code", async () => {
  const { owner } = await fixture();
  const { platformAuditStatement, inviteRef, PLATFORM_AUDIT_ACTIONS } = await import("../../lib/platformAudit");
  const { platformDb } = await import("../../lib/platform");
  const stmt = platformAuditStatement({ actorId: owner.id, action: "invite.created", targetType: "invite", targetId: inviteRef("a-secret-code") });
  await platformDb().execute(stmt);
  const rows = await platformDb().execute(`SELECT id, target_id FROM platform_audit WHERE action = 'invite.created'`);
  expect(String(rows.rows.at(-1)?.target_id)).toMatch(/^inv_[0-9a-f]{12}$/);
  expect(JSON.stringify(rows.rows)).not.toContain("a-secret-code");
  await expect(platformDb().execute(`UPDATE platform_audit SET action = 'credits.granted'`)).rejects.toThrow(/append-only/);
  await expect(platformDb().execute(`DELETE FROM platform_audit`)).rejects.toThrow(/append-only/);
  /* Anything outside the list is refused before it is written. */
  expect(() => platformAuditStatement({ actorId: owner.id, action: "credits.granted", targetType: "workspace", targetId: "w", details: { note: "free text" } as never })).toThrow();
  expect(() => platformAuditStatement({ actorId: owner.id, action: "invite.created", targetType: "invite", targetId: "someone@example.com" })).toThrow();
  expect(() => platformAuditStatement({ actorId: owner.id, action: "credits.granted", targetType: "workspace", targetId: "w", details: { credits: Number.NaN } })).toThrow();
  expect(() => platformAuditStatement({ actorId: owner.id, action: "delete.everything" as never, targetType: "workspace", targetId: "w" })).toThrow();
  expect(PLATFORM_AUDIT_ACTIONS).toContain("save.retried");
});

test("Overview counts: workspaces, people, and credits GIVEN this month (a bought pack is not a grant)", async () => {
  const { owner, wsA } = await fixture();
  const { grantCredits } = await import("../../lib/platform");
  const { consoleOverview } = await import("../../lib/platformConsole.server");
  const first = await consoleOverview();
  expect(first.workspaces).toBeGreaterThanOrEqual(2);
  expect(first.people).toBeGreaterThanOrEqual(2);
  await grantCredits(wsA.id, 40, "Given", owner.id, "manual");
  await grantCredits(wsA.id, 500, "Bought", owner.id, "purchase");
  const next = await consoleOverview();
  expect(next.grantedThisMonth - first.grantedThisMonth).toBe(40);
  /* Last month's grants are not this month's. */
  const lastMonth = new Date(); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  expect((await consoleOverview(lastMonth.getTime())).grantedThisMonth).toBeLessThan(next.grantedThisMonth);
});

test("the workspace sheet: members, credit history, the owner's own changes; the house has no credit history and no balance", async () => {
  const { owner, wsA } = await fixture();
  const { workspaceSheet } = await import("../../lib/platformConsole.server");
  const { grantCredits } = await import("../../lib/platform");
  await grantCredits(wsA.id, 7, "For the sheet", owner.id, "manual", { actorId: owner.id });
  const sheet = (await workspaceSheet(wsA.id))!;
  expect(sheet.name).toBe(wsA.name);
  expect(sheet.members.map((m) => m.email).sort()).toEqual([A.email, B.email].sort());
  expect(sheet.history.length).toBeGreaterThan(0);
  expect(sheet.history[0].at).toBeGreaterThanOrEqual(sheet.history.at(-1)!.at);
  expect(sheet.changes.some((c) => c.action === "credits.granted")).toBe(true);
  expect(await workspaceSheet("ws_missing")).toBeNull();
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  const house = await workspaceSheet(HOUSE_WORKSPACE_ID);
  if (house) { expect(house.house).toBe(true); expect(house.history).toEqual([]); expect(house.balance).toBeNull(); }
});

async function render(ws: Awaited<ReturnType<typeof fixture>>["wsA"], id: string, stored: string | null) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,stored_url,error,created_by,created_at,updated_at,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,0)`,
      args: [id, "seedance-2-0", "p", "{}", "succeeded", stored, stored ? null : "Storage write timed out", "u", Date.now() - 7_200_000, Date.now()],
    });
  });
}

test("Failed saves: each workspace is read in its own database; stored renders are not listed; a retry reaches only its own workspace's render", async () => {
  const { owner, wsA, wsB } = await fixture();
  const { listFailedSaves, retryFailedSave, forgetFailedSaves, RetryRefused } = await import("../../lib/platformFailedSaves");
  await render(wsA, `gen-a-${run}`, null);
  await render(wsA, `gen-a-ok-${run}`, "/api/media/x");
  await render(wsB, `gen-b-${run}`, null);
  forgetFailedSaves();
  const read = await listFailedSaves();
  const ours = read.items.filter((i) => i.id.endsWith(run));
  expect(ours.map((i) => [i.workspaceName, i.id]).sort()).toEqual([[wsA.name, `gen-a-${run}`], [wsB.name, `gen-b-${run}`]].sort());
  expect(ours.every((i) => i.lastError === "Storage write timed out" && i.since < Date.now() - 3_600_000)).toBe(true);
  /* Another workspace's render named under this workspace's id is refused: nothing is tried, nothing is written. */
  const total = (await lines("action = 'save.retried'")).length;
  let tried = 0;
  const sync = async () => { tried++; return { stored: true }; };
  await expect(retryFailedSave({ workspaceId: wsA.id, id: `gen-b-${run}`, actorId: owner.id }, sync)).rejects.toBeInstanceOf(RetryRefused);
  await expect(retryFailedSave({ workspaceId: wsA.id, id: `gen-a-ok-${run}`, actorId: owner.id }, sync)).rejects.toBeInstanceOf(RetryRefused);
  await expect(retryFailedSave({ workspaceId: "ws_missing", id: `gen-a-${run}`, actorId: owner.id }, sync)).rejects.toBeInstanceOf(RetryRefused);
  expect(tried).toBe(0);
  expect((await lines("action = 'save.retried'")).length).toBe(total);
  /* Its own: tried once, on the record whether it saved or not. */
  expect(await retryFailedSave({ workspaceId: wsA.id, id: `gen-a-${run}`, actorId: owner.id }, sync)).toEqual({ saved: true });
  expect(await retryFailedSave({ workspaceId: wsB.id, id: `gen-b-${run}`, actorId: owner.id }, async () => ({ stored: false }))).toEqual({ saved: false });
  expect(tried).toBe(1);
  expect((await lines("action = 'save.retried'")).slice(total)).toEqual([
    { action: "save.retried", actor: owner.id, target: `gen-a-${run}`, workspace: wsA.id, details: { saved: true } },
    { action: "save.retried", actor: owner.id, target: `gen-b-${run}`, workspace: wsB.id, details: { saved: false } },
  ]);
});

test("Retry save: a save that worked is reported as saved even when its audit line cannot be written", async () => {
  const { wsA } = await fixture();
  const { retryFailedSave, forgetFailedSaves } = await import("../../lib/platformFailedSaves");
  await render(wsA, `gen-audit-${run}`, null);
  forgetFailedSaves();
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
  try {
    /* An actor id the line refuses: the line cannot be written, the answer is still the real one. */
    expect(await retryFailedSave({ workspaceId: wsA.id, id: `gen-audit-${run}`, actorId: "not an id!" }, async () => ({ stored: true }))).toEqual({ saved: true });
  } finally { console.error = log; }
  expect(logged.some((l) => l.includes("platform_audit.write_failed"))).toBe(true);
  expect(await lines("target_id = ?", [`gen-audit-${run}`])).toEqual([]);
});

test("AI models: only engines in the registry with a working key and a price; only text models that can be saved and have a price", async () => {
  const { consoleModels } = await import("../../lib/platformConsole.server");
  const { TEXT_MODEL_IDS } = await import("../../lib/platformLayer");
  const { MODELS } = await import("../../lib/models");
  const models = await consoleModels();
  expect(models.engines.length).toBeGreaterThan(0);
  for (const e of models.engines) {
    const def = MODELS.find((m) => m.id === e.id)!;
    expect(def, "in the registry").toBeTruthy();
    expect(def.hidden ?? false).toBe(false);
    expect(e.credits).toBeGreaterThan(0);
  }
  expect(models.engines.some((e) => e.kind === "video")).toBe(true);
  expect(models.engines.some((e) => e.kind === "image")).toBe(true);
  expect(models.defaults.video).toBeTruthy();
  for (const t of models.text.models) {
    expect(TEXT_MODEL_IDS).toContain(t.id);
    expect(t.inputUsdPerM).toBeGreaterThan(0);
    expect(t.outputUsdPerM).toBeGreaterThanOrEqual(t.inputUsdPerM);
  }
  expect(models.text.jobs.map((j) => j.job)).toEqual(["enhance", "idea", "shot"]);
});

test("AI models: with no key nothing is listed; with one provider's key only that provider's models are", async () => {
  const { consoleModels } = await import("../../lib/platformConsole.server");
  const names = ["ENGINE_MOCK", "ARK_API_KEY", "FAL_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "ELEVENLABS_API_KEY", "HF_CREDENTIALS", "HF_API_KEY_ID", "HF_API_KEY_SECRET", "TEXT_DIRECT", "VERCEL", "VERCEL_OIDC_TOKEN"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    const none = await consoleModels();
    expect(none.engines).toEqual([]);
    expect(none.text.models).toEqual([]);
    process.env.ARK_API_KEY = "test-key-not-real";
    const ark = await consoleModels();
    expect(ark.engines.length).toBeGreaterThan(0);
    expect(ark.engines.every((e) => e.id.includes("seedance"))).toBe(true);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    process.env.TEXT_DIRECT = "anthropic";
    const claude = await consoleModels();
    expect(claude.text.models.length).toBeGreaterThan(0);
    expect(claude.text.models.every((m) => m.provider === "anthropic")).toBe(true);
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
});
