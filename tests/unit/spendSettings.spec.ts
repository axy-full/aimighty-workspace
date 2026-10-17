import { test, expect } from "@playwright/test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantToken, TenantUser, TenantWorkspace } from "../../lib/tenant";

/*
 * v30 A4 (docs/plans/v30-data-model.md § 4.6): a workspace's own spend settings, STORED ONLY, behind V30_SPEND_LIMIT
 * (off). The monthly spend limit in credits, the paused state, and ask before every take (off by default; owner,
 * 17 Oct, item 3). Admin-only to change, people only, audited per change, scoped to the workspace's own database, inert
 * with the switch off, and read by nothing that spends today. Every figure here is synthetic, built in the test. No
 * engine is called (ENGINE_MOCK); no credit is spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-spend-settings-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const FLAG = "V30_SPEND_LIMIT";

const HOUSE = "ws_legacy";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string, file = id): TenantWorkspace => ({
  id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(dir, `${file}.db`)}`, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
const fileOf = (ws: TenantWorkspace) => ws.dbUrl.slice("file:".length);
const person = (id: string, role: "admin" | "member", extra: Partial<TenantUser> = {}): TenantUser => ({
  id, email: `${id}@example.test`, name: id, role, owner: false, disabled: false, lastSeen: null, createdAt: 0, ...extra,
});
const token = (scope: TenantToken["scope"]): TenantToken => ({ id: `tok_${scope}`, name: "outside agent", scope, capUsd: null });

async function inWs<T>(ws: TenantWorkspace, fn: () => Promise<T>, user: TenantUser | null = null, tok?: TenantToken): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user, ...(tok ? { token: tok } : {}) });
}
async function rows<T = Record<string, unknown>>(ws: TenantWorkspace, sql: string, args: unknown[] = []): Promise<T[]> {
  const { db, ready } = await import("../../lib/db");
  return inWs(ws, async () => { await ready(); return (await db().execute({ sql, args: args as never })).rows as unknown as T[]; });
}
const settingRows = (ws: TenantWorkspace) => rows<{ key: string; value: string; updated_by: string }>(ws,
  "SELECT key, value, updated_by FROM settings WHERE key IN ('monthlySpendLimitCredits','spendPause','askBeforeEveryTake') ORDER BY key");
const auditRows = (ws: TenantWorkspace) => rows<{ workspace_id: string; actor_id: string | null; action: string; target_type: string; target_id: string; details: string }>(ws,
  "SELECT workspace_id, actor_id, action, target_type, target_id, details FROM security_audit WHERE action LIKE 'spend%' ORDER BY created_at, rowid");

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const was = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
  try { return await fn(); } finally { if (was === undefined) delete process.env[FLAG]; else process.env[FLAG] = was; }
}

/** Lists workspaces on the new interface (the platform owner's site setting), merged into the row and put back afterwards. */
async function listed<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const previous = (await platformDb().execute("SELECT value, updated_at, updated_by FROM platform_layer WHERE key='site'")).rows[0];
  const site = previous ? (JSON.parse(String(previous.value)) as Record<string, unknown>) : {};
  const had = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
  await platformDb().execute({
    sql: `INSERT INTO platform_layer(key,value,updated_at,updated_by) VALUES('site',?,?,'test')
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    args: [JSON.stringify({ ...site, newInterfaceWorkspaces: [...ids, ...had.filter((id) => !ids.includes(id))] }), Date.now()],
  });
  try { return await fn(); } finally {
    if (previous) await platformDb().execute({ sql: "UPDATE platform_layer SET value=?, updated_at=?, updated_by=? WHERE key='site'", args: [previous.value, previous.updated_at, previous.updated_by] });
    else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
}

const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return e as Error & { status?: number }; } return null; };

test("the values: defaults, the stored forms, a strict change, and the month a limit counts in (calendar month, UTC)", async () => {
  const s = await import("../../lib/spendSettings");
  const { tokenMonthStart } = await import("../../lib/cycle");
  /* Defaults: no limit, running, and ask before every take OFF (owner, 17 Oct, item 3). */
  expect(s.SPEND_SETTINGS_DEFAULT).toEqual({ monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false });
  expect(s.spendSettingsFrom({})).toEqual(s.SPEND_SETTINGS_DEFAULT);
  /* Stored forms round-trip. Synthetic figures. */
  const limit = 4321, pause = { at: 1_700_000_000_000, by: "u_admin", reason: "admin" as const };
  expect(s.spendSettingsFrom({ monthlySpendLimitCredits: s.limitValue(limit), spendPause: s.pauseValue(pause), askBeforeEveryTake: s.askValue(true) }))
    .toEqual({ monthlyLimitCredits: limit, pause, askBeforeEveryTake: true });
  expect(s.storedPause(s.pauseValue({ at: 5, by: null, reason: "limit" }))).toEqual({ at: 5, by: null, reason: "limit" });
  /* A stored value that is not one the writer makes reads as the default. */
  for (const raw of ["", " ", "0", "-3", "1.5", "abc", "99999999", String(s.SPEND_LIMIT_MAX_CREDITS + 1)]) expect(s.storedLimit(raw), raw).toBeNull();
  /* A pause: blank is running; anything else this writer never makes FAILS CLOSED, read as paused ("unreadable"). */
  expect(s.storedPause("")).toBeNull();
  expect(s.storedPause(undefined)).toBeNull();
  for (const raw of ["{}", "[]", "nope", "null", "0", '{"at":1,"by":"u","reason":"other"}', '{"at":-1,"by":"u","reason":"admin"}', '{"at":1,"by":"a b","reason":"admin"}'])
    expect(s.storedPause(raw), raw).toEqual({ at: 0, by: null, reason: "unreadable" });
  /* A member's view drops who paused; the rest is the same. */
  const full = { monthlyLimitCredits: limit, pause, askBeforeEveryTake: true };
  expect(s.forMember(full)).toEqual({ monthlyLimitCredits: limit, pause: { at: pause.at, reason: "admin" }, askBeforeEveryTake: true });
  expect(JSON.stringify(s.forMember(full))).not.toContain("u_admin");
  expect(s.forMember(s.SPEND_SETTINGS_DEFAULT)).toEqual(s.SPEND_SETTINGS_DEFAULT);
  for (const raw of ["", "off", "ON", "1", "true"]) expect(s.storedAsk(raw), raw).toBe(false);
  /* A change is strict: one bad key or value refuses all of it. */
  expect(s.parseSpendPatch({ monthlyLimitCredits: limit, paused: true, askBeforeEveryTake: false })).toEqual({ patch: { monthlyLimitCredits: limit, paused: true, askBeforeEveryTake: false } });
  expect(s.parseSpendPatch({ monthlyLimitCredits: null })).toEqual({ patch: { monthlyLimitCredits: null } });
  for (const bad of [null, [], "x", {}, { workspaceId: "ws_other" }, { monthlyLimitCredits: limit, workspaceId: "ws_other" }, { monthlyLimitCredits: 0 }, { monthlyLimitCredits: -1 },
    { monthlyLimitCredits: 1.5 }, { monthlyLimitCredits: String(limit) }, { monthlyLimitCredits: s.SPEND_LIMIT_MAX_CREDITS + 1 }, { paused: "yes" }, { askBeforeEveryTake: 1 },
    { spendPause: "" }, { reason: "limit" }, { paused: true, reason: "limit" }]) {
    expect(s.parseSpendPatch(bad).error, JSON.stringify(bad)).toBeTruthy();
  }
  /* The period: the UTC calendar month, half-open, the same turn as a token's monthly ceiling. */
  const mid = Date.UTC(2026, 9, 17, 12), start = Date.UTC(2026, 9, 1), end = Date.UTC(2026, 10, 1);
  expect(s.spendLimitPeriod(mid)).toEqual({ start, end });
  expect(s.spendLimitPeriod(end)).toEqual({ start: end, end: Date.UTC(2026, 11, 1) });
  expect(s.spendLimitPeriod(end - 1)).toEqual({ start, end });
  expect(s.spendLimitPeriod(Date.UTC(2026, 11, 31, 23, 59))).toEqual({ start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) });
  expect(s.spendLimitPeriod(mid).start).toBe(tokenMonthStart(mid));
  /* The switch is exactly "1". */
  for (const v of [undefined, "", "0", "true", "on", " 1", "1 "]) expect(s.spendSettingsSwitchOn({ [FLAG]: v }), String(v)).toBe(false);
  expect(s.spendSettingsSwitchOn({ [FLAG]: "1" })).toBe(true);
});

test("switch off is inert: every entry refuses with a 404 before the database is opened, and an existing database gains nothing", async () => {
  const store = await import("../../lib/spendSettings.server");
  const admin = person("u_admin", "admin");
  for (const value of [undefined, "", "0", "true", "on", " 1"]) {
    await withFlag(value, async () => {
      const fresh = workspace(HOUSE, `house-never-opened-${run}-${String(value).trim() || "unset"}`);
      for (const call of [() => store.readSpendSettings(), () => store.changeSpendSettings({ monthlyLimitCredits: 10, paused: true, askBeforeEveryTake: true }), () => store.recordLimitPause()] as (() => Promise<unknown>)[]) {
        const e = await refusal(() => inWs(fresh, call, admin));
        expect(e, String(value)).toBeInstanceOf(store.SpendSettingsError);
        expect(e!.status).toBe(404);
      }
      expect(existsSync(fileOf(fresh)), String(value)).toBe(false);
    });
  }
  /* An existing database: nothing written, no table, column, index or trigger added. */
  const existing = workspace(HOUSE, `house-existing-${run}`);
  const schema = () => rows(existing, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const before = { schema: await schema(), settings: await rows(existing, "SELECT * FROM settings ORDER BY key"), audit: await rows(existing, "SELECT * FROM security_audit") };
  await withFlag("0", async () => {
    for (const call of [() => store.readSpendSettings(), () => store.changeSpendSettings({ monthlyLimitCredits: 10 }), () => store.recordLimitPause()] as (() => Promise<unknown>)[])
      expect((await refusal(() => inWs(existing, call, person("u_admin", "admin"))))?.status).toBe(404);
  });
  expect({ schema: await schema(), settings: await rows(existing, "SELECT * FROM settings ORDER BY key"), audit: await rows(existing, "SELECT * FROM security_audit") }).toEqual(before);
  /* Switch on, but a workspace without the new interface: still off. */
  await withFlag("1", async () => {
    const other = workspace(`ws_not_listed_${run}`);
    expect((await refusal(() => inWs(other, () => store.readSpendSettings(), person("u_admin", "admin"))))?.status).toBe(404);
    expect(existsSync(fileOf(other))).toBe(false);
    expect(await store.spendSettingsOn(other)).toBe(false);
    expect(await store.spendSettingsOn(workspace(HOUSE, "house-probe"))).toBe(true);
  });
});

test("defaults on a workspace that never set them, with the month they count in", async () => {
  const store = await import("../../lib/spendSettings.server");
  const at = Date.UTC(2026, 1, 14, 9);
  await withFlag("1", async () => {
    const ws = workspace(HOUSE, `house-defaults-${run}`);
    expect(await inWs(ws, () => store.readSpendSettings(at), person("u_member", "member"))).toEqual({
      monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false, period: { start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 2, 1) },
    });
    expect(await settingRows(ws)).toEqual([]);
  });
});

test("an admin's every change writes one audit line in the same batch; a value that does not change writes neither; a failed audit line rolls the change back", async () => {
  const store = await import("../../lib/spendSettings.server");
  const admin = person("u_admin", "admin");
  const ws = workspace(HOUSE, `house-audit-${run}`);
  const change = (patch: Parameters<typeof store.changeSpendSettings>[0], at: number) => inWs(ws, () => store.changeSpendSettings(patch, at), admin);
  await withFlag("1", async () => {
    const LIMIT = 777, HIGHER = 888;
    const first = await change({ monthlyLimitCredits: LIMIT }, 1000);
    expect(first.changed).toEqual(["monthlyLimitCredits"]);
    expect(first.settings).toMatchObject({ monthlyLimitCredits: LIMIT, pause: null, askBeforeEveryTake: false });
    /* The same again: no write, no line. */
    expect((await change({ monthlyLimitCredits: LIMIT, paused: false, askBeforeEveryTake: false }, 1001)).changed).toEqual([]);
    expect((await change({ paused: true }, 1002)).settings.pause).toEqual({ at: 1002, by: admin.id, reason: "admin" });
    expect((await change({ paused: true }, 1003)).changed).toEqual([]);
    expect((await change({ askBeforeEveryTake: true, monthlyLimitCredits: HIGHER }, 1004)).changed).toEqual(["monthlyLimitCredits", "askBeforeEveryTake"]);
    expect((await change({ paused: false }, 1005)).settings.pause).toBeNull();
    expect((await change({ paused: false }, 1006)).changed).toEqual([]);
    expect((await change({ askBeforeEveryTake: false, monthlyLimitCredits: null }, 1007)).settings).toMatchObject({ monthlyLimitCredits: null, askBeforeEveryTake: false });
    const lines = await auditRows(ws);
    expect(lines.map((l) => [l.action, JSON.parse(l.details)])).toEqual([
      ["spend_limit.set", { limitCredits: LIMIT }],
      ["spend.paused", { reason: "admin" }],
      ["spend_limit.set", { limitCredits: HIGHER }],
      ["spend.ask_every_take_on", {}],
      ["spend.resumed", {}],
      ["spend_limit.set", { limitCredits: null }],
      ["spend.ask_every_take_off", {}],
    ]);
    for (const l of lines) expect(l).toMatchObject({ workspace_id: ws.id, actor_id: admin.id, target_type: "workspace", target_id: ws.id });
    expect(new Set((await settingRows(ws)).map((r) => r.updated_by))).toEqual(new Set([admin.id]));
    /* The server's own pause on reaching the limit (no caller yet): reason "limit", no person; once only. */
    expect(await inWs(ws, () => store.recordLimitPause(2000))).toBe(true);
    expect(await inWs(ws, () => store.recordLimitPause(2001))).toBe(false);
    expect((await inWs(ws, () => store.readSpendSettings())).pause).toEqual({ at: 2000, by: null, reason: "limit" });
    expect((await auditRows(ws)).at(-1)).toMatchObject({ action: "spend.paused", actor_id: null, details: JSON.stringify({ reason: "limit" }) });
    /* An admin's resume clears the limit's pause too. */
    expect((await change({ paused: false }, 2002)).changed).toEqual(["paused"]);
    /* The audit line and the change commit together: a refused line leaves the setting as it was. */
    const before = { settings: await settingRows(ws), audit: await auditRows(ws) };
    await rows(ws, "CREATE TRIGGER reject_spend_audit BEFORE INSERT ON security_audit WHEN NEW.action LIKE 'spend%' BEGIN SELECT RAISE(ABORT,'spend receipt unavailable'); END");
    try {
      expect((await refusal(() => change({ monthlyLimitCredits: 999, paused: true, askBeforeEveryTake: true }, 3000)))?.message).toMatch(/spend receipt unavailable/);
      expect({ settings: await settingRows(ws), audit: await auditRows(ws) }).toEqual(before);
    } finally { await rows(ws, "DROP TRIGGER reject_spend_audit"); }
  });
});

test("races: two pauses at once, or a person's pause beside the server's, write one pause and one audit line; a stale read changes nothing; `changed` is right on every call", async () => {
  const store = await import("../../lib/spendSettings.server");
  const adminA = person("u_admin_one", "admin"), adminB = person("u_admin_two", "admin");
  const pauses = async (ws: TenantWorkspace) => (await settingRows(ws)).filter((r) => r.key === "spendPause");
  await withFlag("1", async () => {
    /* Two admins press Pause at the same moment. */
    const two = workspace(HOUSE, `house-race-two-${run}`);
    const [one, other] = await Promise.all([
      inWs(two, () => store.changeSpendSettings({ paused: true }, 5000), adminA),
      inWs(two, () => store.changeSpendSettings({ paused: true }, 5001), adminB),
    ]);
    expect([one.changed, other.changed].sort((a, b) => a.length - b.length)).toEqual([[], ["paused"]]);
    const winner = one.changed.length ? adminA : adminB;
    expect(await pauses(two)).toHaveLength(1);
    expect(JSON.parse((await pauses(two))[0].value)).toMatchObject({ by: winner.id, reason: "admin" });
    expect((await auditRows(two)).map((l) => [l.action, l.actor_id])).toEqual([["spend.paused", winner.id]]);
    /* Both answers show the one pause that stands. */
    expect(one.settings.pause).toEqual(other.settings.pause);

    /* A person's pause beside the server's limit pause. */
    const mixed = workspace(HOUSE, `house-race-mixed-${run}`);
    const [byPerson, byServer] = await Promise.all([
      inWs(mixed, () => store.changeSpendSettings({ paused: true }, 6000), adminA),
      inWs(mixed, () => store.recordLimitPause(6001)),
    ]);
    expect(Number(byPerson.changed.length) + Number(byServer)).toBe(1);
    expect(await pauses(mixed)).toHaveLength(1);
    const lines = await auditRows(mixed);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject(byServer ? { action: "spend.paused", actor_id: null, details: '{"reason":"limit"}' } : { action: "spend.paused", actor_id: adminA.id, details: '{"reason":"admin"}' });

    /* A stale read: the row says paused, the read says running. Pausing again writes nothing and says so. */
    const stale = workspace(HOUSE, `house-race-stale-${run}`);
    await inWs(stale, () => store.changeSpendSettings({ paused: true }, 7000), adminA);
    const seeded = { settings: await settingRows(stale), audit: await auditRows(stale) };
    const running = { monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false };
    const again = await inWs(stale, () => store.changeSpendSettingsFromReadForTests({ paused: true }, running, 7001), adminB);
    expect(again.changed).toEqual([]);
    expect(again.settings.pause).toEqual({ at: 7000, by: adminA.id, reason: "admin" });
    expect({ settings: await settingRows(stale), audit: await auditRows(stale) }).toEqual(seeded);
    /* And the other way: the row says running, a stale read says paused. Resuming writes nothing and says so. */
    await inWs(stale, () => store.changeSpendSettings({ paused: false }, 7002), adminA);
    const resumed = { settings: await settingRows(stale), audit: await auditRows(stale) };
    const paused = { ...running, pause: { at: 7000, by: adminA.id, reason: "admin" as const } };
    const resumeAgain = await inWs(stale, () => store.changeSpendSettingsFromReadForTests({ paused: false }, paused, 7003), adminB);
    expect(resumeAgain.changed).toEqual([]);
    expect({ settings: await settingRows(stale), audit: await auditRows(stale) }).toEqual(resumed);
    /* A stale limit read: the limit is already the value asked for, so nothing is written. */
    await inWs(stale, () => store.changeSpendSettings({ monthlyLimitCredits: 444 }, 7004), adminA);
    const limited = { settings: await settingRows(stale), audit: await auditRows(stale) };
    const sameLimit = await inWs(stale, () => store.changeSpendSettingsFromReadForTests({ monthlyLimitCredits: 444 }, running, 7005), adminB);
    expect(sameLimit.changed).toEqual([]);
    expect({ settings: await settingRows(stale), audit: await auditRows(stale) }).toEqual(limited);
    /* The test-only entry still refuses a member. */
    expect((await refusal(() => inWs(stale, () => store.changeSpendSettingsFromReadForTests({ paused: true }, running), person("u_member", "member"))))?.status).toBe(403);
  });
});

test("a damaged pause row fails closed: it reads as paused, the server's limit pause does not overwrite it, and an admin's resume clears it with one line", async () => {
  const store = await import("../../lib/spendSettings.server");
  const admin = person("u_admin", "admin");
  const ws = workspace(HOUSE, `house-damaged-${run}`);
  await withFlag("1", async () => {
    await rows(ws, "INSERT INTO settings(key,value,updated_by,updated_at) VALUES('spendPause','not a pause','fixture',0)");
    expect((await inWs(ws, () => store.readSpendSettings(), person("u_member", "member"))).pause).toEqual({ at: 0, by: null, reason: "unreadable" });
    expect(await inWs(ws, () => store.recordLimitPause(8000))).toBe(false);
    expect((await inWs(ws, () => store.changeSpendSettings({ paused: true }, 8001), admin)).changed).toEqual([]);
    expect(await auditRows(ws)).toEqual([]);
    const resumed = await inWs(ws, () => store.changeSpendSettings({ paused: false }, 8002), admin);
    expect(resumed.changed).toEqual(["paused"]);
    expect(resumed.settings.pause).toBeNull();
    expect((await auditRows(ws)).map((l) => [l.action, l.actor_id])).toEqual([["spend.resumed", admin.id]]);
  });
});

test("only an admin who is a person changes them: a member, a disabled admin, an agent identity and any API or MCP token are refused, and nothing is written", async () => {
  const store = await import("../../lib/spendSettings.server");
  const { PeopleOnlyError } = await import("../../lib/security/people-only");
  const ws = workspace(HOUSE, `house-who-${run}`);
  const patch = { monthlyLimitCredits: 55, paused: true, askBeforeEveryTake: true };
  await withFlag("1", async () => {
    const member = await refusal(() => inWs(ws, () => store.changeSpendSettings(patch), person("u_member", "member")));
    expect(member).toBeInstanceOf(store.SpendSettingsError);
    expect(member!.status).toBe(403);
    const cases: [string, TenantUser | null, TenantToken | undefined][] = [
      ["no one", null, undefined],
      ["a disabled admin", person("u_gone", "admin", { disabled: true }), undefined],
      ["Atomik's identity", person("agent:run_1", "admin"), undefined],
      ["the server", person("server", "admin"), undefined],
      ["an admin's render token", person("u_admin", "admin", { owner: true }), token("render")],
      ["an admin's prepare token (MCP)", person("u_admin", "admin", { owner: true }), token("prepare")],
      ["an admin's read token", person("u_admin", "admin", { owner: true }), token("read")],
    ];
    for (const [label, user, tok] of cases) {
      const e = await refusal(() => inWs(ws, () => store.changeSpendSettings(patch), user, tok));
      expect(e, label).toBeInstanceOf(PeopleOnlyError);
      expect(e!.status, label).toBe(403);
    }
    expect(await settingRows(ws)).toEqual([]);
    expect(await auditRows(ws)).toEqual([]);
    /* A member may read them. */
    expect((await inWs(ws, () => store.readSpendSettings(), person("u_member", "member"))).askBeforeEveryTake).toBe(false);
  });
});

test("tenant isolation: each workspace's settings and audit lines stay in its own database; an admin of A never reads or changes B's", async () => {
  const store = await import("../../lib/spendSettings.server");
  const { readWorkspaceSecurityHistory } = await import("../../lib/securityAudit");
  const { createClient } = await import("@libsql/client");
  const a = workspace(HOUSE, `iso-a-${run}`), b = workspace(`ws_iso_b_${run}`);
  const adminA = person("u_admin_a", "admin"), adminB = person("u_admin_b", "admin");
  await withFlag("1", () => listed([b.id], async () => {
    await inWs(a, () => store.changeSpendSettings({ monthlyLimitCredits: 111, paused: true, askBeforeEveryTake: true }), adminA);
    /* B sees its defaults, not A's. */
    expect(await inWs(b, () => store.readSpendSettings(), adminB)).toMatchObject({ monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false });
    await inWs(b, () => store.changeSpendSettings({ monthlyLimitCredits: 222 }), adminB);
    /* A is unchanged by B's change. */
    expect(await inWs(a, () => store.readSpendSettings(), adminA)).toMatchObject({ monthlyLimitCredits: 111, askBeforeEveryTake: true });
    expect((await inWs(a, () => store.readSpendSettings(), adminA)).pause).toMatchObject({ by: adminA.id, reason: "admin" });
    /* Each database holds only its own workspace's lines. */
    expect(new Set((await auditRows(a)).map((l) => l.workspace_id))).toEqual(new Set([a.id]));
    expect(new Set((await auditRows(b)).map((l) => l.workspace_id))).toEqual(new Set([b.id]));
    expect((await auditRows(b)).map((l) => l.actor_id)).toEqual([adminB.id]);
    /* The history read for B, pointed at A's database, finds nothing of A's. */
    const aClient = createClient({ url: a.dbUrl });
    try { expect((await readWorkspaceSecurityHistory([aClient], b.id, 100, null)).events).toEqual([]); } finally { aClient.close(); }
    /* A's admin, in A's scope, has no way to name B: a change that names a workspace is refused as a whole. */
    const { parseSpendPatch } = await import("../../lib/spendSettings");
    expect(parseSpendPatch({ workspaceId: b.id, monthlyLimitCredits: 1 }).error).toBeTruthy();
    /* The same account as a member of B (its role there) cannot change B. */
    expect((await refusal(() => inWs(b, () => store.changeSpendSettings({ monthlyLimitCredits: 1 }), person(adminA.id, "member"))))?.status).toBe(403);
    expect(await inWs(b, () => store.readSpendSettings(), adminB)).toMatchObject({ monthlyLimitCredits: 222 });
  }));
});

/* ---- The route, through the real withTenant and auth (platform session lookups stubbed, as tests/unit/demo-gaps-l4-people-only.spec.ts does). ---- */

const RWS = workspace(HOUSE, `route-${run}`);
/* The house workspace's tokens are the `aw_` kind (lib/auth.ts workspaceForToken). */
const RAW = `aw_${"5".repeat(48)}`;
let mode: "admin" | "member" | "token" = "admin";
const userIdOf = () => (mode === "member" ? "rmem" : "radmin");

function load<T>(file: string, deps: Record<string, unknown>): T {
  const filename = path.resolve(file), req = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(deps, name)) return deps[name];
      if (name.startsWith("@/")) return req(path.resolve(name.slice(2)));
      return req(name);
    },
    mod, mod.exports,
  );
  return mod.exports as T;
}

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
async function routes() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => (mode !== "token" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(mode === "token" ? { authorization: `Bearer ${RAW}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => ({ account: { id: userIdOf(), name: userIdOf(), email: `${userIdOf()}@example.invalid`, mfa_enabled: 1 }, workspaceId: RWS.id }),
      workspacesFor: async () => [{ workspace: RWS, role: mode === "member" ? "member" : "admin" }],
      getWorkspace: async (id: string) => (id === RWS.id ? RWS : null),
      legacyWorkspace: async () => RWS,
      platformReady: async () => {},
      platformDb: () => ({ execute: async () => ({ rows: [{ role: "admin" }] }) }),
    },
  });
  const deps = { "@/lib/auth": auth, "@/lib/tenant": tenant, "@/lib/db": database, "@/lib/workbench/request-scope": scope };
  return {
    spend: load<{ GET: Handler; PATCH: Handler }>("app/api/settings/spend/route.ts", deps),
    settings: load<{ GET: Handler; PATCH: Handler }>("app/api/settings/route.ts", deps),
    scope,
  };
}
let seeded = false;
async function seedRoute() {
  if (seeded) return;
  const { db, ready } = await import("../../lib/db");
  const { tokenHash } = await import("../../lib/auth");
  await inWs(RWS, async () => {
    await ready();
    await db().batch([
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('radmin','radmin@example.invalid','Route admin','x','admin',0)",
      "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('rmem','rmem@example.invalid','Route member','x','member',0)",
      /* The admin's own token, render scope: the strongest a token gets. */
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('tok_spend',?,'outside agent','radmin','render',0)", args: [tokenHash(RAW)] },
    ], "write");
  });
  seeded = true;
}
const call = async (api: Awaited<ReturnType<typeof routes>>, handler: Handler, url: string, method: string, body?: unknown) => handler(new Request(`http://localhost${url}`, {
  method, headers: { "Content-Type": "application/json", ...(mode !== "token" ? { "X-Workbench-Scope": api.scope.workbenchScopeFor(RWS.id, userIdOf()) } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}), undefined);

test("the route: off, every caller withTenant lets through gets a 404 and nothing is read or written; on, an admin's session changes them, a member and an admin's own token are refused, and the general settings route neither takes nor sends them", async () => {
  await seedRoute();
  const api = await routes();
  const LIMIT = 321;
  /* Off: a 404 to everyone, before anything is written. */
  await withFlag(undefined, async () => {
    for (const m of ["admin", "member", "token"] as const) {
      mode = m;
      expect((await call(api, api.spend.GET, "/api/settings/spend", "GET")).status, m).toBe(404);
      expect((await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", { monthlyLimitCredits: LIMIT })).status, m).toBe(404);
    }
    expect(await settingRows(RWS)).toEqual([]);
  });
  await withFlag("1", async () => {
    mode = "member";
    const read = await call(api, api.spend.GET, "/api/settings/spend", "GET");
    expect(read.status).toBe(200);
    expect((await read.json()).settings).toMatchObject({ monthlyLimitCredits: null, pause: null, askBeforeEveryTake: false });
    const byMember = await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", { monthlyLimitCredits: LIMIT });
    expect(byMember.status).toBe(403);
    expect((await byMember.json()).error).toBe("Admins only");
    mode = "token";
    for (const [method, handler] of [["GET", api.spend.GET], ["PATCH", api.spend.PATCH]] as const) {
      const byToken = await call(api, handler, "/api/settings/spend", method, method === "PATCH" ? { monthlyLimitCredits: LIMIT, paused: true } : undefined);
      expect(byToken.status, method).toBe(403);
      expect((await byToken.json()).error, method).toMatch(/requires a signed-in browser session/);
    }
    expect(await settingRows(RWS)).toEqual([]);
    expect(await auditRows(RWS)).toEqual([]);
    mode = "admin";
    /* A change that names a workspace, or anything but the three, is refused whole. */
    for (const bad of [{ workspaceId: "ws_other", monthlyLimitCredits: LIMIT }, { monthlyLimitCredits: "321" }, {}])
      expect((await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await settingRows(RWS)).toEqual([]);
    const ok = await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", { monthlyLimitCredits: LIMIT, askBeforeEveryTake: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ changed: ["monthlyLimitCredits", "askBeforeEveryTake"], settings: { monthlyLimitCredits: LIMIT, askBeforeEveryTake: true } });
    expect((await auditRows(RWS)).map((l) => [l.action, l.actor_id])).toEqual([["spend_limit.set", "radmin"], ["spend.ask_every_take_on", "radmin"]]);
    /* Who paused is an account id: an admin is sent it, a member is not. */
    expect((await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", { paused: true })).status).toBe(200);
    const adminView = (await (await call(api, api.spend.GET, "/api/settings/spend", "GET")).json()).settings;
    expect(adminView.pause).toMatchObject({ by: "radmin", reason: "admin" });
    mode = "member";
    const memberView = (await (await call(api, api.spend.GET, "/api/settings/spend", "GET")).json()).settings;
    expect(memberView.pause).toEqual({ at: adminView.pause.at, reason: "admin" });
    expect(JSON.stringify(memberView)).not.toContain("radmin");
    mode = "admin";
    expect((await call(api, api.spend.PATCH, "/api/settings/spend", "PATCH", { paused: false })).status).toBe(200);
    /* The general settings route: it does not accept these keys from an admin, and does not send them to a member. */
    const general = await call(api, api.settings.PATCH, "/api/settings", "PATCH", { monthlySpendLimitCredits: "1", spendPause: "{}", askBeforeEveryTake: "off" });
    expect(general.status).toBe(400);
    expect((await settingRows(RWS)).map((r) => [r.key, r.value])).toEqual([["askBeforeEveryTake", "on"], ["monthlySpendLimitCredits", String(LIMIT)], ["spendPause", ""]]);
    mode = "member";
    const sent = await (await call(api, api.settings.GET, "/api/settings", "GET")).json();
    for (const key of ["monthlySpendLimitCredits", "spendPause", "askBeforeEveryTake"]) {
      expect(Object.keys(sent.settings), key).not.toContain(key);
      expect(Object.keys(sent.defaults), key).not.toContain(key);
    }
  });
  mode = "admin";
});

/* ---- Nothing that spends today reads them. ---- */

const ROOT = path.resolve(".");
const SKIP_AT_ROOT = new Set([".next", ".claude", "tests", "test-results", "coverage", "out", "build", "dist", ".vercel", ".data", "docs", "design"]);
function sources(dirPath = ROOT, out: string[] = []): string[] {
  for (const name of readdirSync(dirPath)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dirPath, name), rel = path.relative(ROOT, full);
    if (dirPath === ROOT && SKIP_AT_ROOT.has(name)) continue;
    if (rel === path.join("public", "vendor")) continue;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}

test("guard (new, strict): only the A4 files name the stored keys or the switch, and only its route imports its store", () => {
  const files = sources();
  expect(files).toContain("lib/generationRequests.ts");
  expect(files).toContain("app/api/settings/route.ts");
  const named = (pattern: RegExp) => files.filter((f) => pattern.test(readFileSync(f, "utf8"))).sort();
  /* The stored keys: the two A4 modules, and lib/settings.ts, which lists them only to keep them out of the general route's answer. */
  expect(named(/monthlySpendLimitCredits|spendPause|askBeforeEveryTake/)).toEqual(["lib/settings.ts", "lib/spendSettings.server.ts", "lib/spendSettings.ts"]);
  const settingsSource = readFileSync("lib/settings.ts", "utf8");
  const internal = settingsSource.slice(settingsSource.indexOf("export const INTERNAL_SETTING_KEYS"), settingsSource.indexOf("];", settingsSource.indexOf("export const INTERNAL_SETTING_KEYS")));
  expect(settingsSource.replace(internal, "").match(/monthlySpendLimitCredits|spendPause|askBeforeEveryTake/g)).toBeNull();
  expect(named(/V30_SPEND_LIMIT/)).toEqual(["app/api/settings/spend/route.ts", "lib/spendSettings.server.ts", "lib/spendSettings.ts"]);
  /* Who imports the modules: the store imports the pure one; the route imports both; nothing else does. */
  expect(named(/from\s+["'][^"']*spendSettings\.server["']|(?:import|require)\(\s*["'][^"']*spendSettings\.server["']\s*\)/)).toEqual(["app/api/settings/spend/route.ts"]);
  expect(named(/from\s+["'][^"']*\/spendSettings["']|(?:import|require)\(\s*["'][^"']*\/spendSettings["']\s*\)/)).toEqual(["app/api/settings/spend/route.ts", "lib/spendSettings.server.ts"]);
  /* The stale-read entry is for the tests alone. */
  expect(named(/changeSpendSettingsFromReadForTests/)).toEqual(["lib/spendSettings.server.ts"]);
  /* The server's own pause has no caller yet: the route never names it. */
  expect(named(/recordLimitPause/)).toEqual(["lib/spendSettings.server.ts"]);
  /* The audit actions are written by the store alone. */
  expect(named(/spend_limit\.set|spend\.paused|spend\.resumed|spend\.ask_every_take_/)).toEqual(["lib/securityAudit.ts", "lib/spendSettings.server.ts"]);
});

test("today's quote, credit wall, reservation and meter are identical whether or not a workspace has a limit below the job, is paused, and asks before every take", async () => {
  const store = await import("../../lib/spendSettings.server");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { quotedCredits, creditCheck, creditState } = await import("../../lib/credits");
  const { freshSettings } = await import("../../lib/settings");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  const { db, ready } = await import("../../lib/db");
  await platformReady();
  await alignLedgerUnit();
  const set = workspace(`ws_spend_set_${run}`), plain = workspace(`ws_spend_plain_${run}`);
  const admin = person("u_spend_admin", "admin");
  /* Synthetic: a grant and a job of about five credits; the limit is one credit, below the job. */
  const GRANT = 1000, JOB_CREDITS = 5, LIMIT_BELOW_JOB = 1;
  const usd = JOB_CREDITS / creditsAtTerms(1, currentBillingTerms("video", "mock"));
  for (const ws of [set, plain]) await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,?,?)", args: [`grant_${ws.id}`, ws.id, GRANT, "Test", 0] });
  const outcome = async (ws: TenantWorkspace) => inWs(ws, async () => {
    await ready();
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('prod_spend','A synthetic production',0)" });
    const quote = quotedCredits(usd, currentBillingTerms("video", "mock"));
    const wall = await creditCheck("ark", usd, currentBillingTerms("video", "mock"));
    const id = `gen_${ws.id}`;
    await reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: usd, projectId: "prod_spend", shotId: "shot_spend" });
    const meter = (await platformDb().execute({ sql: "SELECT kind, engine, model, status, engine_cost_usd, billed_credits, paid_by_platform FROM meter_events WHERE id=? AND workspace_id=?", args: [id, ws.id] })).rows.map((r) => ({ ...r }));
    const reserved = Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE id=? AND workspace_id=?", args: [id, ws.id] })).rows[0].n);
    const state = await creditState();
    return { quote, wall, meter, reserved, state };
  }, admin);
  await withFlag("1", () => listed([set.id, plain.id], async () => {
    await inWs(set, () => store.changeSpendSettings({ monthlyLimitCredits: LIMIT_BELOW_JOB, paused: true, askBeforeEveryTake: true }), admin);
    /* The reservation's own fresh read of the settings carries the keys, and it reserves anyway: nothing reads them. */
    const seen = await inWs(set, () => freshSettings());
    expect(seen).toMatchObject({ monthlySpendLimitCredits: String(LIMIT_BELOW_JOB), askBeforeEveryTake: "on" });
    expect(seen.spendPause).toContain('"reason":"admin"');
    const withSettings = await outcome(set), without = await outcome(plain);
    expect(withSettings.reserved).toBe(1);
    expect(withSettings.wall).toEqual({ ok: true });
    expect(withSettings.meter).toHaveLength(1);
    expect(withSettings.quote).toBeGreaterThan(LIMIT_BELOW_JOB);
    expect(withSettings).toEqual(without);
  }));
});
