import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

/* The console's pure side (lib/v12/settingsConsole.ts), the shell's spellings for it, and the history lines. The routes themselves are held in tests/workspace-settings-v12-workbench.spec.ts. */
const directory = mkdtempSync(join(tmpdir(), "particl-settings-console-"));
process.env.PLATFORM_DATABASE_URL = `file:${join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

test("an admin has the eight workspace sections and a member two, the account two for both; an address a member may not open lands on Profile", async () => {
  const { navFor, sectionFor } = await import("../../lib/v12/settingsConsole");
  expect(navFor(true).map((g) => g.items.map((i) => i.id))).toEqual([["overview", "people", "billing", "usage", "defaults", "rules", "limits", "workspace"], ["profile", "notifications"]]);
  expect(navFor(false).map((g) => g.items.map((i) => i.id))).toEqual([["usage", "billing"], ["profile", "notifications"]]);
  expect(navFor(false)[0].items.map((i) => i.label)).toEqual(["Your usage", "Plan"]);
  expect(sectionFor(null, true)).toBe("overview");
  expect(sectionFor("people", true)).toBe("people");
  expect(sectionFor("nonsense", true)).toBe("overview");
  expect(sectionFor(null, false)).toBe("profile");
  for (const adminOnly of ["overview", "people", "defaults", "rules", "limits", "workspace"]) expect(sectionFor(adminOnly, false), adminOnly).toBe("profile");
  for (const ok of ["usage", "billing", "profile", "notifications"]) expect(sectionFor(ok, false), ok).toBe(ok);
});

test("the small words: last active, an invitation's name, seats, months, the typed delete name", async () => {
  const { lastActive, nameFromEmail, seatsLine, monthChoices, deleteTypedOk } = await import("../../lib/v12/settingsConsole");
  const now = new Date("2026-10-12T12:00:00").getTime();
  expect(lastActive(null, now)).toBe("Never");
  expect(lastActive(now - 3_600_000, now)).toBe("Today");
  expect(lastActive(now - 86_400_000, now)).toBe("Yesterday");
  expect(lastActive(now - 3 * 86_400_000, now)).toBe("3 d ago");
  expect(nameFromEmail("sam.iyer@studio.example")).toBe("Sam Iyer");
  expect(nameFromEmail("pat_99@studio.example")).toBe("Pat");
  expect(nameFromEmail("123@studio.example")).toBe("Teammate");
  expect(seatsLine({ used: 3, ceiling: 5 }, 2)).toBe("3 of 5 seats used");
  expect(seatsLine({ used: 3, ceiling: null }, 2)).toBe("3 people");
  expect(seatsLine(null, 1)).toBe("1 person");
  expect(monthChoices(Date.UTC(2026, 0, 15)).map((m) => [m.key, m.label])).toEqual([["2026-01", "This month"], ["2025-12", "Last month"]]);
  expect(deleteTypedOk(" Our Studio ", "Our Studio")).toBe(true);
  expect(deleteTypedOk("our studio", "Our Studio")).toBe(false);
  expect(deleteTypedOk("", "")).toBe(false);
});

test("engines are the rate card's, each once, silent, at their usual size, with the card's own price", async () => {
  const { enginePicks } = await import("../../lib/v12/settingsConsole");
  const groups = [
    { kind: "video" as const, axis: "resolution", seconds: 5, rows: [
      { engine: "seedance-2.5", label: "Seedance 2.5", audio: false, cells: [{ option: "720p", credits: 18 }, { option: "1080p", credits: 43 }] },
      { engine: "seedance-2.5", label: "Seedance 2.5", audio: true, cells: [{ option: "1080p", credits: 60 }] },
      { engine: "kling-3-pro", label: "Kling 3.0 Pro", audio: false, cells: [{ option: "1080p", credits: 13 }] },
    ] },
    { kind: "image" as const, axis: "size", seconds: null, rows: [{ engine: "nano-banana-2", label: "Nano Banana 2", audio: false, cells: [{ option: "512", credits: 1 }, { option: "1K", credits: 2 }] }] },
    { kind: "image" as const, axis: "quality", seconds: null, rows: [{ engine: "nano-banana-pro", label: "Nano Banana Pro", audio: false, cells: [{ option: "1K", credits: 3 }, { option: "4K", credits: 5 }] }] },
  ];
  expect(enginePicks(groups, "video")).toEqual([
    { id: "seedance-2.5", label: "Seedance 2.5", credits: 43, at: "1080p · 5 s" },
    { id: "kling-3-pro", label: "Kling 3.0 Pro", credits: 13, at: "1080p · 5 s" },
  ]);
  expect(enginePicks(groups, "image").map((p) => [p.label, p.credits, p.at])).toEqual([["Nano Banana 2", 2, "1K"], ["Nano Banana Pro", 3, "1K"]]);
  expect(enginePicks(null, "video")).toEqual([]);
});

test("the registry has the engines the owner named, and the card prices them from the engine registry, not from here", async () => {
  const { MODELS } = await import("../../lib/models");
  const labels = MODELS.filter((m) => !m.hidden).map((m) => m.label);
  expect(labels).toContain("Kling 3.0 Pro");
  expect(labels).toContain("Nano Banana Pro");
  const { rateCard } = await import("../../lib/workbench/media-reach");
  const card = rateCard(() => true);
  const priced = card.flatMap((g) => g.rows.map((r) => r.label));
  expect(priced).toContain("Kling 3.0 Pro");
  expect(priced).toContain("Nano Banana Pro");
});

test("prototype v14's addresses open the console in the shell's own spelling", async () => {
  const { route } = await import("../../lib/shell/screens");
  const to = (search: string) => new URLSearchParams(route(search));
  expect(to("?view=settings").get("view")).toBe("workspace");
  expect(to("?view=settings").get("tab")).toBe("console");
  const people = to("?view=settings&section=people");
  expect([people.get("view"), people.get("tab"), people.get("section")]).toEqual(["workspace", "console", "people"]);
  const billing = to("?view=billing");
  expect([billing.get("view"), billing.get("tab"), billing.get("section")]).toEqual(["workspace", "console", "billing"]);
  /* The old Settings addresses are unchanged. */
  expect(to("?view=workspace&tab=team").get("tab")).toBe("team");
});

test("the history knows invitations, limits and leaving; its details are fixed words and whole numbers, never a link, a name or an address", async () => {
  const { securityAuditStatement, SECURITY_AUDIT_SCHEMA } = await import("../../lib/securityAudit");
  const client = createClient({ url: `file:${join(directory, "audit.db")}` });
  try {
    await client.batch(SECURITY_AUDIT_SCHEMA);
    for (const input of [
      { action: "invite.created" as const, targetType: "invite" as const, targetId: "0123456789abcdef", details: { role: "admin" as const, expiresAt: 1_800_000_000_000 } },
      { action: "invite.resent" as const, targetType: "invite" as const, targetId: "0123456789abcdef" },
      { action: "invite.revoked" as const, targetType: "invite" as const, targetId: "0123456789abcdef" },
      { action: "limits.updated" as const, targetType: "limits" as const, targetId: "board", details: { limit: "board" as const, value: 500 } },
      { action: "limits.updated" as const, targetType: "limits" as const, targetId: "warn", details: { limit: "warn" as const, value: null } },
      { action: "member.left" as const, targetType: "member" as const, targetId: "account-1" },
      { action: "workspace.renamed" as const, targetType: "workspace" as const, targetId: "workspace-1" },
      { action: "workspace.deleted" as const, targetType: "workspace" as const, targetId: "workspace-1" },
    ]) await client.execute(securityAuditStatement({ workspaceId: "workspace-1", actorId: "account-1", ...input }));
    expect((await client.execute("SELECT COUNT(*) AS n FROM security_audit")).rows[0].n).toBe(8);
    const bad = (details: Record<string, unknown>) => () => securityAuditStatement({ workspaceId: "workspace-1", actorId: "a", action: "limits.updated", targetType: "limits", targetId: "board", details: details as never });
    expect(bad({ limit: "person", value: 5 })).toThrow(/detail/);
    expect(bad({ limit: "board", value: -1 })).toThrow(/detail/);
    expect(bad({ limit: "board", value: 1.5 })).toThrow(/detail/);
    expect(bad({ email: "someone@example.test" })).toThrow(/detail/);
    expect(() => securityAuditStatement({ workspaceId: "workspace-1", actorId: "a", action: "invite.created", targetType: "invite", targetId: "an invite code with spaces" })).toThrow(/identifier/);
  } finally { client.close(); }
});

test("an invitation is named in the history by a reference that is not its link, the same each time", async () => {
  const { inviteRef } = await import("../../lib/securityAudit");
  const code = "Zm9yLXRlc3RzLW9ubHktdGhpcy1pcy1ub3QtYS1yZWFsLWNvZGU";
  expect(inviteRef(code)).toMatch(/^[0-9a-f]{16}$/);
  expect(inviteRef(code)).toBe(inviteRef(code));
  expect(inviteRef(code)).not.toContain(code.slice(0, 8));
  expect(inviteRef(`${code}x`)).not.toBe(inviteRef(code));
});

test("the last admin guard counts live admins other than the one leaving, and never Particl support", async () => {
  const { assertAnotherAdmin, LAST_ADMIN } = await import("../../lib/teamAdmins");
  const client = createClient({ url: `file:${join(directory, "admins.db")}` });
  try {
    await client.batch([
      "CREATE TABLE memberships(workspace_id TEXT, account_id TEXT, role TEXT, disabled INTEGER DEFAULT 0)",
      "CREATE TABLE accounts(id TEXT PRIMARY KEY, email TEXT, name TEXT, deleted_at INTEGER, disabled INTEGER DEFAULT 0)",
      "INSERT INTO accounts(id,email,name) VALUES('a1','a1@example.test','A1'),('a2','a2@example.test','A2'),('sup','support@example.test','Support'),('m1','m1@example.test','M1')",
      "INSERT INTO memberships(workspace_id,account_id,role) VALUES('w','a1','admin'),('w','sup','admin'),('w','m1','member')",
    ]);
    const mask = { hides: (who: { id?: unknown }) => who.id === "sup" };
    const tx = await client.transaction("read");
    try {
      /* a1 is the only admin that is not Particl support: it cannot go. */
      await expect(assertAnotherAdmin(tx as never, "w", "a1", mask)).rejects.toThrow(LAST_ADMIN);
      /* a member leaving is not the guard's business, but asking about someone else is fine. */
      await expect(assertAnotherAdmin(tx as never, "w", "m1", mask)).resolves.toBeUndefined();
    } finally { tx.close(); }
    await client.execute("INSERT INTO memberships(workspace_id,account_id,role) VALUES('w','a2','admin')");
    const again = await client.transaction("read");
    try { await expect(assertAnotherAdmin(again as never, "w", "a1", mask)).resolves.toBeUndefined(); } finally { again.close(); }
    /* A disabled admin does not count. */
    await client.execute("UPDATE memberships SET disabled=1 WHERE account_id='a2'");
    const last = await client.transaction("read");
    try { await expect(assertAnotherAdmin(last as never, "w", "a1", mask)).rejects.toThrow(LAST_ADMIN); } finally { last.close(); }
  } finally { client.close(); }
});

test("a limit change reads its old value inside the write: saves at once leave exactly one line for one real change", async () => {
  const { setLimitSetting } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES('ws-limits','ws-limits','Limits house',?,1,'owner',0,0)",
    args: [`file:${join(directory, "ws-limits.db")}`],
  });
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id='ws-limits'", args: [] })).rows[0]);
  await runInTenant(ws, async () => {
    await ready();
    const lines = async () => (await db().execute("SELECT details FROM security_audit WHERE action='limits.updated' AND workspace_id='ws-limits' ORDER BY created_at,rowid")).rows.map((r) => JSON.parse(String(r.details)) as { limit: string; value: number });
    /* Five saves of the same new value at the same time: 80 (the default) to 70 happens once. */
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => setLimitSetting("capWarnPct", "70", `admin-${i}`, "ws-limits")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await lines()).toEqual([{ limit: "warn", value: 70 }]);
    /* The same value again, and a different one, in turn. */
    expect(await setLimitSetting("capWarnPct", "70", "admin-9", "ws-limits")).toBe(false);
    expect(await setLimitSetting("capWarnPct", "90", "admin-9", "ws-limits")).toBe(true);
    expect(await lines()).toEqual([{ limit: "warn", value: 70 }, { limit: "warn", value: 90 }]);
    expect(await setLimitSetting("shotCapCredits", "60", "admin-9", "ws-limits")).toBe(true);
    expect((await lines()).at(-1)).toEqual({ limit: "shot", value: 60 });
  });
});
