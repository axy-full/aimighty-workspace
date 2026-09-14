import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { totpAt } from "../../lib/totp";
const directory = mkdtempSync(join(tmpdir(), "particl-workspace-security-"));
process.env.PLATFORM_DATABASE_URL = `file:${join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${join(directory, "legacy.db")}`;
process.env.KEYRING_SECRET = "isolated-workspace-policy-test-secret";
process.env.ENGINE_MOCK = "1";
const password = "Workspace policy test passphrase 2026";
async function fixture(id: string) {
  id = `policy${id}`;
  const p = await import("../../lib/platform"),
    auth = await import("../../lib/auth"),
    security = await import("../../lib/accountSecurity");
  await p.platformReady();
  const db = p.platformDb(),
    workspaceId = `ws_${id}`,
    at = Date.now();
  await db.execute({
    sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    args: [id, `${id}@example.test`, id, auth.hashPassword(password), at],
  });
  await db.execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    args: [
      workspaceId,
      id,
      id,
      `file:${join(directory, id + ".db")}`,
      id,
      at,
      at,
    ],
  });
  await db.execute({
    sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',?)",
    args: [workspaceId, id, at],
  });
  const session = await p.createPlatformSession(id, workspaceId);
  const scope = `particl-active-${workspaceId}-${id}`;
  return { id, db, p, auth, security, workspaceId, session, scope };
}
async function enrol(f: Awaited<ReturnType<typeof fixture>>) {
  const started = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "begin",
    requestScope: f.scope,
  });
  const result = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "enable",
    requestScope: f.scope,
    code: totpAt(started.setup!.secret, Date.now()),
  });
  return { ...f, session: result.session!, codes: result.recoveryCodes! };
}
function change(
  f: Awaited<ReturnType<typeof enrol>>,
  requiresMfa = true,
  index = 0,
) {
  return f.security.changeWorkspaceSecurity({
    accountId: f.id,
    session: f.session,
    requestScope: f.scope,
    password,
    code: f.codes[index],
    requiresMfa,
  });
}

test("workspace policy defaults off, requires owner enrollment and a fresh factor, and records a scoped audit", async () => {
  const original = await fixture("owner");
  expect(
    (await original.p.getWorkspace(original.workspaceId))?.requiresMfa,
  ).toBe(false);
  await expect(
    original.security.changeWorkspaceSecurity({
      accountId: original.id,
      session: original.session,
      requestScope: original.scope,
      password,
      code: "",
      requiresMfa: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const f = await enrol(original);
  await change(f);
  expect(
    await f.security.readWorkspaceSecurity(f.id, f.session, f.scope),
  ).toEqual({
    requiresMfa: true,
    ownerEnrolled: true,
    members: 1,
    unenrolled: 0,
  });
  expect((await f.p.getWorkspace(f.workspaceId))?.requiresMfa).toBe(true);
  expect(
    (await f.security.readAccountSecurity(f.id, f.session)).requiredWorkspaces,
  ).toEqual([{ id: f.workspaceId, name: f.id }]);
  await expect(change(f, false)).rejects.toMatchObject({ status: 401 });
  const rows = (
    await f.db.execute({
      sql: "SELECT action,target_id,workspace_id FROM security_audit WHERE action='workspace.mfa_required' AND workspace_id=?",
      args: [f.workspaceId],
    })
  ).rows;
  expect(rows).toEqual([
    {
      action: "workspace.mfa_required",
      target_id: f.workspaceId,
      workspace_id: f.workspaceId,
    },
  ]);
});

test("policy authorizes live owner standing and captured session scope inside its transaction", async () => {
  const f = await enrol(await fixture("standing"));
  await expect(
    f.security.changeWorkspaceSecurity({
      accountId: f.id,
      session: f.session,
      requestScope: "particl-active-wrong-wrong",
      password,
      code: f.codes[0],
      requiresMfa: true,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await f.db.execute({
    sql: "UPDATE memberships SET role='admin' WHERE workspace_id=?",
    args: [f.workspaceId],
  });
  await expect(change(f)).rejects.toMatchObject({ status: 403 });
  await expect(
    f.security.readWorkspaceSecurity(f.id, f.session, f.scope),
  ).rejects.toMatchObject({ status: 403 });
  await f.db.execute({
    sql: "UPDATE memberships SET role='owner' WHERE workspace_id=?",
    args: [f.workspaceId],
  });
  await f.db.execute({
    sql: "UPDATE workspaces SET owner_id='different' WHERE id=?",
    args: [f.workspaceId],
  });
  await expect(change(f)).rejects.toMatchObject({ status: 403 });
  await f.db.execute({
    sql: "UPDATE workspaces SET owner_id=? WHERE id=?",
    args: [f.id, f.workspaceId],
  });
  await f.p.destroyPlatformSession(f.session);
  await expect(change(f)).rejects.toMatchObject({ status: 401 });
  expect((await f.p.getWorkspace(f.workspaceId))?.requiresMfa).toBe(false);
});

test("required memberships prevent factor disablement and preserve the recovery code on rejection", async () => {
  const f = await enrol(await fixture("disable"));
  await change(f);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "disable",
      code: f.codes[1],
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(9);
  await change(f, false, 1);
  const result = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "disable",
    code: f.codes[2],
  });
  expect(
    (await f.security.readAccountSecurity(f.id, result.session!)).enabled,
  ).toBe(false);
});

test("policy reads use one SELECT and retain live session, fallback workspace and factor standing", async () => {
  const f = await fixture("read-snapshot");
  const statements: string[] = [];
  const native = f.db.execute.bind(f.db);
  f.db.execute = ((
    statement: Parameters<typeof native>[0],
    args?: Parameters<typeof native>[1],
  ) => {
    statements.push(
      typeof statement === "string"
        ? statement
        : String((statement as { sql: string }).sql),
    );
    return native(statement, args);
  }) as typeof f.db.execute;
  try {
    expect(
      await f.security.readWorkspaceSecurity(f.id, f.session, f.scope),
    ).toEqual({
      requiresMfa: false,
      ownerEnrolled: false,
      members: 1,
      unenrolled: 1,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0].trim()).toMatch(/^SELECT /);
  } finally {
    f.db.execute = native;
  }
  await expect(
    f.security.readWorkspaceSecurity(
      f.id,
      f.session,
      "particl-active-stale-stale",
    ),
  ).rejects.toMatchObject({ status: 409 });
  await f.db.execute({
    sql: "UPDATE p_sessions SET workspace_id='missing' WHERE account_id=?",
    args: [f.id],
  });
  expect(
    (await f.security.readWorkspaceSecurity(f.id, f.session, f.scope)).members,
  ).toBe(1);
  await f.db.execute({
    sql: "UPDATE memberships SET disabled=1 WHERE account_id=?",
    args: [f.id],
  });
  await expect(
    f.security.readWorkspaceSecurity(f.id, f.session, f.scope),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.security.readWorkspaceSecurity(
      f.id,
      f.session,
      `particl-account-${f.id}`,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await f.db.execute({
    sql: "UPDATE memberships SET disabled=0 WHERE account_id=?",
    args: [f.id],
  });
  const enrolled = await enrol(f);
  await expect(
    f.security.readWorkspaceSecurity(f.id, f.session, f.scope),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (await f.security.readWorkspaceSecurity(f.id, enrolled.session, f.scope))
      .ownerEnrolled,
  ).toBe(true);
  await f.db.execute({
    sql: "UPDATE account_security SET epoch=epoch+1 WHERE account_id=?",
    args: [f.id],
  });
  await expect(
    f.security.readWorkspaceSecurity(f.id, enrolled.session, f.scope),
  ).rejects.toMatchObject({ status: 401 });
});

test("a required second workspace also prevents disabling an account's factor", async () => {
  const f = await enrol(await fixture("second")),
    other = await fixture("other");
  await f.db.execute({
    sql: "UPDATE workspaces SET requires_mfa=1 WHERE id=?",
    args: [other.workspaceId],
  });
  await f.db.execute({
    sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'member',?)",
    args: [other.workspaceId, f.id, Date.now()],
  });
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "disable",
      code: f.codes[0],
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await f.security.readAccountSecurity(f.id, f.session)).requiredWorkspaces,
  ).toEqual([{ id: other.workspaceId, name: other.id }]);
});

test("policy audit failure and last-code protection roll back both policy and factor use", async () => {
  const f = await enrol(await fixture("rollback"));
  await f.db.execute(
    "CREATE TRIGGER reject_workspace_policy BEFORE INSERT ON security_audit WHEN NEW.action='workspace.mfa_required' BEGIN SELECT RAISE(ABORT,'policy audit unavailable'); END",
  );
  try {
    await expect(change(f)).rejects.toThrow(/policy audit unavailable/);
  } finally {
    await f.db.execute("DROP TRIGGER reject_workspace_policy");
  }
  expect((await f.p.getWorkspace(f.workspaceId))?.requiresMfa).toBe(false);
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(10);
  await f.db.execute({
    sql: "UPDATE account_recovery_codes SET used_at=? WHERE account_id=? AND code_hash NOT IN (SELECT code_hash FROM account_recovery_codes WHERE account_id=? ORDER BY code_hash LIMIT 1)",
    args: [Date.now(), f.id, f.id],
  });
  const remaining = (
    await f.db.execute({
      sql: "SELECT code_hash FROM account_recovery_codes WHERE account_id=? AND used_at IS NULL",
      args: [f.id],
    })
  ).rows[0];
  const code = f.codes.find(
    (value) =>
      f.auth.tokenHash(
        `particl-recovery:${f.id}:${value.replace(/-/g, "").toUpperCase()}`,
      ) === remaining.code_hash,
  )!;
  await expect(
    f.security.changeWorkspaceSecurity({
      accountId: f.id,
      session: f.session,
      requestScope: f.scope,
      password,
      code,
      requiresMfa: true,
    }),
  ).rejects.toThrow(/last code/);
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(1);
  expect((await f.p.getWorkspace(f.workspaceId))?.requiresMfa).toBe(false);
});

test("concurrent factor disablement and required policy cannot leave an unenrolled owner with required MFA", async () => {
  const f = await enrol(await fixture("race"));
  const results = await Promise.allSettled([
    change(f),
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "disable",
      code: f.codes[1],
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const row = (
    await f.db.execute({
      sql: "SELECT w.requires_mfa,asec.enabled_at FROM workspaces w JOIN account_security asec ON asec.account_id=w.owner_id WHERE w.id=?",
      args: [f.workspaceId],
    })
  ).rows[0];
  expect(Number(row.requires_mfa) === 1 && row.enabled_at === null).toBe(false);
});

test("workspace policy pauses an unenrolled member's existing API token and restores it after real enrollment", async () => {
  const f = await fixture("token");
  const ws = (await f.p.getWorkspace(f.workspaceId))!;
  const { runInTenant } = await import("../../lib/tenant"),
    { db, ready } = await import("../../lib/db");
  await f.p.mirrorUser(
    ws,
    { id: f.id, name: f.id, email: `${f.id}@example.test` },
    "owner",
    false,
  );
  const raw = await runInTenant(ws, async () => {
    await ready();
    const raw = f.auth.mintTokenSecret();
    await db().execute({
      sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('fixture',?,'Read',?,'read',?)",
      args: [f.auth.tokenHash(raw), f.id, Date.now()],
    });
    return raw;
  });
  expect((await f.auth.callerFromToken(raw))?.user?.id).toBe(f.id);
  await f.db.execute({
    sql: "UPDATE workspaces SET requires_mfa=1 WHERE id=?",
    args: [f.workspaceId],
  });
  expect(await f.auth.callerFromToken(raw)).toBeNull();
  const enrolled = await enrol(f);
  expect((await f.p.sessionLookup(enrolled.session))?.account.mfa_enabled).toBe(
    1,
  );
  expect((await f.auth.callerFromToken(raw))?.user?.id).toBe(f.id);
  await f.db.execute({
    sql: "UPDATE memberships SET disabled=1 WHERE account_id=?",
    args: [f.id],
  });
  expect(await f.auth.callerFromToken(raw)).toBeNull();
});
