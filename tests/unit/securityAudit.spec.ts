import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SECURITY_AUDIT_SCHEMA,
  securityAuditStatement,
  readWorkspaceSecurityHistory,
  parseAuditCursor,
} from "../../lib/securityAudit";

const directory = mkdtempSync(join(tmpdir(), "particl-security-audit-"));
process.env.PLATFORM_DATABASE_URL = `file:${join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${join(directory, "legacy.db")}`;
process.env.KEYRING_SECRET = "isolated-security-audit-fixture-secret";
process.env.ENGINE_MOCK = "1";

const event = (workspaceId = "workspace-a") => ({
  workspaceId,
  actorId: "actor-a",
  action: "api_token.created" as const,
  targetType: "api_token" as const,
  targetId: "token-a",
});

test("security receipts are append-only and a failed receipt rolls the protected write back", async () => {
  const client = createClient({ url: `file:${join(directory, "atomic.db")}` });
  try {
    await client.batch([
      ...SECURITY_AUDIT_SCHEMA,
      "CREATE TABLE fixture_token(id TEXT PRIMARY KEY)",
    ]);
    await client.batch(
      [
        "INSERT INTO fixture_token VALUES('first')",
        securityAuditStatement(event()),
      ],
      "write",
    );
    await expect(client.execute("DELETE FROM security_audit")).rejects.toThrow(
      /append-only/,
    );
    await expect(
      client.execute("UPDATE security_audit SET actor_id='changed'"),
    ).rejects.toThrow(/append-only/);
    await client.execute(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await expect(
      client.batch(
        [
          "INSERT INTO fixture_token VALUES('second')",
          securityAuditStatement(event()),
        ],
        "write",
      ),
    ).rejects.toThrow(/audit unavailable/);
    expect(
      (await client.execute("SELECT id FROM fixture_token")).rows.map(
        (row) => row.id,
      ),
    ).toEqual(["first"]);
  } finally {
    client.close();
  }
});

test("history merges owning databases with stable pagination without leaking another workspace", async () => {
  const clients = ["history-platform", "history-tenant"].map((name) =>
    createClient({ url: `file:${join(directory, name + ".db")}` }),
  );
  try {
    const timestamp = 1_700_000_000_000;
    const fixedId = (n: number) =>
      `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    for (const [source, client] of clients.entries()) {
      await client.batch(SECURITY_AUDIT_SCHEMA);
      // Insert fixed fixture values directly. Never UPDATE immutable receipts.
      // Interleaving IDs across databases forces ties on every page boundary.
      for (let i = 0; i < 6; i++)
        await client.execute({
          sql: "INSERT INTO security_audit(id,workspace_id,actor_id,action,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?,?)",
          args: [
            fixedId(i * 2 + source + 1),
            i === 5 ? "workspace-private" : "workspace-a",
            "actor-a",
            "api_token.created",
            "api_token",
            "token-a",
            "{}",
            timestamp,
          ],
        });
    }
    const found: string[] = [];
    let cursor: ReturnType<typeof parseAuditCursor> = null;
    do {
      const page = await readWorkspaceSecurityHistory(
        clients,
        "workspace-a",
        3,
        cursor,
      );
      expect(page.events.length).toBeLessThanOrEqual(3);
      expect(
        page.events.every(
          (item) =>
            item.workspaceId === "workspace-a" && item.createdAt === timestamp,
        ),
      ).toBe(true);
      found.push(...page.events.map((item) => item.id));
      cursor = parseAuditCursor(page.nextCursor);
    } while (cursor);
    expect(found).toEqual(
      Array.from({ length: 10 }, (_, index) => fixedId(10 - index)),
    );
    expect(new Set(found).size).toBe(10);
    const samePhysicalDatabase = createClient({
      url: `file:${join(directory, "history-platform.db")}`,
    });
    expect(
      (
        await readWorkspaceSecurityHistory(
          [clients[0], samePhysicalDatabase],
          "workspace-a",
          100,
          null,
        )
      ).events,
    ).toHaveLength(5);
    samePhysicalDatabase.close();
  } finally {
    for (const client of clients) client.close();
  }
});

test("audit accepts only structural metadata and no-op revocation produces no success receipt", async () => {
  expect(() =>
    securityAuditStatement({
      ...event(),
      details: { password: "private" } as never,
    }),
  ).toThrow(/Invalid security history detail/);
  expect(() =>
    securityAuditStatement({ ...event(), actorId: "private@example.test" }),
  ).toThrow(/Invalid security history identifier/);
  expect(() => parseAuditCursor("1:invalid")).toThrow(/Invalid history cursor/);
  const client = createClient({ url: `file:${join(directory, "no-op.db")}` });
  try {
    await client.batch([
      ...SECURITY_AUDIT_SCHEMA,
      "CREATE TABLE tokens(id TEXT)",
    ]);
    await client.batch(
      [
        "DELETE FROM tokens WHERE id='missing'",
        securityAuditStatement(
          { ...event(), action: "api_token.revoked" },
          true,
        ),
      ],
      "write",
    );
    expect(
      (await client.execute("SELECT COUNT(*) n FROM security_audit")).rows[0].n,
    ).toBe(0);
  } finally {
    client.close();
  }
});

test("actual session and vendor mutations commit their receipts and retain both concurrent vendor edits", async () => {
  const platform = await import("../../lib/platform");
  const { open } = await import("../../lib/keyring");
  await platform.platformReady();
  const client = platform.platformDb();
  await client.execute(
    "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('audit-owner','audit@example.test','Owner','fixture',0)",
  );
  await client.execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES('audit-workspace','audit-workspace','Fixture',?,'audit-owner',0,0)",
    args: [`file:${join(directory, "audit-tenant.db")}`],
  });
  await Promise.all([
    platform.updateWorkspaceVendorKey(
      "audit-workspace",
      "ARK_API_KEY",
      "private-vendor-one",
      "audit-owner",
    ),
    platform.updateWorkspaceVendorKey(
      "audit-workspace",
      "FAL_KEY",
      "private-vendor-two",
      "audit-owner",
    ),
  ]);
  const stored = String(
    (
      await client.execute(
        "SELECT keys_enc FROM workspaces WHERE id='audit-workspace'",
      )
    ).rows[0].keys_enc,
  );
  expect(JSON.parse(open(stored))).toEqual({
    ARK_API_KEY: "private-vendor-one",
    FAL_KEY: "private-vendor-two",
  });
  const token = await platform.createPlatformSession(
    "audit-owner",
    "audit-workspace",
  );
  await platform.destroyPlatformSession(token);
  await platform.destroyPlatformSession(token);
  const history = await readWorkspaceSecurityHistory(
    [client],
    "audit-workspace",
    100,
    null,
  );
  expect(history.events.map((item) => item.action).sort()).toEqual([
    "session.created",
    "session.revoked",
    "vendor_key.updated",
    "vendor_key.updated",
  ]);
  expect(JSON.stringify(history)).not.toContain("private-vendor");
  expect(JSON.stringify(history)).not.toContain(token);
  await client.execute(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
  );
  try {
    await expect(
      platform.createPlatformSession("audit-owner", "audit-workspace"),
    ).rejects.toThrow(/receipt failed/);
    await expect(
      platform.updateWorkspaceVendorKey(
        "audit-workspace",
        "FAL_KEY",
        null,
        "audit-owner",
      ),
    ).rejects.toThrow(/receipt failed/);
    expect(
      (
        await client.execute(
          "SELECT COUNT(*) n FROM p_sessions WHERE account_id='audit-owner'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await client.execute(
          "SELECT keys_enc FROM workspaces WHERE id='audit-workspace'",
        )
      ).rows[0].keys_enc,
    ).toBe(stored);
  } finally {
    await client.execute("DROP TRIGGER reject_receipt");
  }
});

async function accountFixture(label: string) {
  const platform = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  await platform.platformReady();
  const client = platform.platformDb(),
    at = Date.now(),
    accountId = `audit-${label}`,
    workspaceId = `workspace-${label}`;
  await client.execute({
    sql: "INSERT INTO accounts(id,email,name,password_hash,failed_count,locked_until,created_at) VALUES(?,?,?,?,7,?,?)",
    args: [
      accountId,
      `${accountId}@example.test`,
      "Fixture member",
      hashPassword("original-fixture-password"),
      at + 3600_000,
      at,
    ],
  });
  await client.execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,plan_id,created_at,updated_at) VALUES(?,?,?,?,?,'agency',?,?)",
    args: [
      workspaceId,
      workspaceId,
      "Isolated fixture",
      `file:${join(directory, workspaceId + ".db")}`,
      accountId,
      at,
      at,
    ],
  });
  await client.execute({
    sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'member',?)",
    args: [workspaceId, accountId, at],
  });
  const workspace = await platform.getWorkspace(workspaceId);
  if (!workspace) throw new Error("Missing local workspace fixture");
  return { client, workspace, accountId, at };
}

test("actual password reset rolls password, sibling reset links and every session back when its audit insert fails", async () => {
  const { client, workspace, accountId, at } = await accountFixture("password");
  const { tokenHash, verifyPassword } = await import("../../lib/auth");
  const { resetAccountPassword } = await import("../../lib/passwordReset");
  const resetTokens = ["private-reset-first", "private-reset-second"],
    sessions = ["private-session-first", "private-session-second"];
  for (const token of resetTokens)
    await client.execute({
      sql: "INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
      args: [tokenHash(token), accountId, at, at + 3600_000],
    });
  for (const token of sessions)
    await client.execute({
      sql: "INSERT INTO p_sessions(token_hash,account_id,workspace_id,created_at,expires_at) VALUES(?,?,?,?,?)",
      args: [tokenHash(token), accountId, workspace.id, at, at + 3600_000],
    });
  const snapshot = async () => ({
    account: (
      await client.execute({
        sql: "SELECT password_hash,failed_count,locked_until FROM accounts WHERE id=?",
        args: [accountId],
      })
    ).rows,
    resets: (
      await client.execute({
        sql: "SELECT token_hash,used_at FROM password_resets WHERE user_id=? ORDER BY token_hash",
        args: [accountId],
      })
    ).rows,
    sessions: (
      await client.execute({
        sql: "SELECT token_hash,workspace_id FROM p_sessions WHERE account_id=? ORDER BY token_hash",
        args: [accountId],
      })
    ).rows,
    history: (
      await readWorkspaceSecurityHistory([client], workspace.id, 100, null)
    ).events,
  });
  const before = await snapshot();
  await client.execute(
    "CREATE TRIGGER reject_password_audit BEFORE INSERT ON security_audit WHEN NEW.action='account.password_reset' BEGIN SELECT RAISE(ABORT,'password receipt unavailable'); END",
  );
  try {
    await expect(
      resetAccountPassword(resetTokens[0], "replacement-fixture-password"),
    ).rejects.toThrow(/password receipt unavailable/);
    expect(await snapshot()).toEqual(before);
  } finally {
    await client.execute("DROP TRIGGER reject_password_audit");
  }
  const result = await resetAccountPassword(
    resetTokens[0],
    "replacement-fixture-password",
  );
  const after = await snapshot();
  expect(
    verifyPassword(
      "replacement-fixture-password",
      String(after.account[0].password_hash),
    ),
  ).toBe(true);
  expect(after.account[0]).toMatchObject({
    failed_count: 0,
    locked_until: null,
  });
  expect(after.resets.every((row) => row.used_at !== null)).toBe(true);
  expect(after.sessions.map((row) => row.token_hash)).toEqual([
    tokenHash(result.session!),
  ]);
  expect(after.history.map((row) => row.action).sort()).toEqual([
    "account.password_reset",
    "session.created",
  ]);
  for (const privateValue of [
    ...resetTokens,
    ...sessions,
    result.session,
    "replacement-fixture-password",
  ])
    expect(JSON.stringify(after.history)).not.toContain(privateValue);
});

type MembershipHandler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;
async function membershipRoute(
  actorId: string,
): Promise<Record<"PATCH" | "DELETE", MembershipHandler>> {
  // Mock only browser authentication/context setup. Execute the current route,
  // transaction helpers, audit writer, membership SQL and mirror repair unchanged.
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(resolve("package.json"))("next/server"),
    "@/lib/securityAudit": await import("../../lib/securityAudit"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/platform": await import("../../lib/platform"),
    "@/lib/accountDb": await import("../../lib/accountDb"),
    "@/lib/teamInvitations": await import("../../lib/teamInvitations"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/auth": {
      withTenant: (handler: MembershipHandler) => handler,
      requireAdmin: async () => ({
        user: { id: actorId, owner: true, role: "admin" },
      }),
      isPlatformOwner: async () => false,
    },
  };
  const compiled = ts.transpileModule(
    readFileSync(resolve("app/api/team/[id]/route.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const evaluated = {
    exports: {} as Record<"PATCH" | "DELETE", MembershipHandler>,
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies))
        throw new Error("Unexpected membership route import " + name);
      return dependencies[name];
    },
    evaluated,
    evaluated.exports,
  );
  return evaluated.exports;
}

for (const operation of ["PATCH", "DELETE"] as const) {
  test(`actual membership ${operation} rolls back access, unlocks, revocations and mirror records when audit persistence fails`, async () => {
    const { client, workspace, accountId, at } = await accountFixture(
      `member-${operation.toLowerCase()}`,
    );
    const { tokenHash } = await import("../../lib/auth");
    const { accountDbReady } = await import("../../lib/accountDb");
    const { runInTenant } = await import("../../lib/tenant");
    const actorId = `owner-${operation.toLowerCase()}`;
    await accountDbReady();
    await client.execute({
      sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,'fixture',?)",
      args: [actorId, `${actorId}@example.test`, "Fixture owner", at],
    });
    await client.execute({
      sql: "UPDATE workspaces SET owner_id=? WHERE id=?",
      args: [actorId, workspace.id],
    });
    workspace.ownerId = actorId;
    await client.execute({
      sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,?,'owner',?)",
      args: [workspace.id, actorId, at],
    });
    for (const workspaceId of [workspace.id, "untouched-workspace"]) {
      await client.execute({
        sql: "INSERT INTO p_sessions(token_hash,account_id,workspace_id,created_at,expires_at) VALUES(?,?,?,?,?)",
        args: [
          tokenHash(`${accountId}-${workspaceId}`),
          accountId,
          workspaceId,
          at,
          at + 3600_000,
        ],
      });
      await client.execute({
        sql: "INSERT INTO workspace_invites(code,workspace_id,email,role,created_by,created_at,expires_at) VALUES(?,?,?,'member',?,?,?)",
        args: [
          `${accountId}-${workspaceId}`,
          workspaceId,
          `${accountId}@example.test`,
          actorId,
          at,
          at + 3600_000,
        ],
      });
    }
    await client.execute({
      sql: "INSERT INTO membership_mirrors(workspace_id,account_id,updated_at) VALUES(?,?,?)",
      args: [workspace.id, accountId, at],
    });
    const route = await membershipRoute(actorId);
    const call = () =>
      runInTenant(workspace, () =>
        route[operation](
          new Request("http://localhost/api/team/" + accountId, {
            method: operation,
            ...(operation === "PATCH"
              ? {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    role: "admin",
                    disabled: true,
                    unlock: true,
                  }),
                }
              : {}),
          }),
          { params: Promise.resolve({ id: accountId }) },
        ),
      );
    const snapshot = async () => ({
      account: (
        await client.execute({
          sql: "SELECT failed_count,locked_until FROM accounts WHERE id=?",
          args: [accountId],
        })
      ).rows,
      membership: (
        await client.execute({
          sql: "SELECT workspace_id,role,disabled FROM memberships WHERE account_id=? ORDER BY workspace_id",
          args: [accountId],
        })
      ).rows,
      sessions: (
        await client.execute({
          sql: "SELECT token_hash,workspace_id FROM p_sessions WHERE account_id=? ORDER BY token_hash",
          args: [accountId],
        })
      ).rows,
      invitations: (
        await client.execute({
          sql: "SELECT code,workspace_id FROM workspace_invites WHERE email=? ORDER BY code",
          args: [`${accountId}@example.test`],
        })
      ).rows,
      mirrors: (
        await client.execute({
          sql: "SELECT workspace_id,updated_at FROM membership_mirrors WHERE account_id=? ORDER BY workspace_id",
          args: [accountId],
        })
      ).rows,
      history: (
        await readWorkspaceSecurityHistory([client], workspace.id, 100, null)
      ).events,
    });
    const before = await snapshot();
    await client.execute(
      "CREATE TRIGGER reject_member_audit BEFORE INSERT ON security_audit WHEN NEW.action IN ('member.updated','member.removed') BEGIN SELECT RAISE(ABORT,'member receipt unavailable'); END",
    );
    try {
      const response = await call();
      expect(response.status).toBe(503);
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.execute("DROP TRIGGER reject_member_audit");
    }
    const response = await call();
    expect(response.status, await response.text()).toBe(200);
    const after = await snapshot();
    expect(after.history.map((row) => row.action)).toEqual([
      operation === "PATCH" ? "member.updated" : "member.removed",
    ]);
    expect(after.history[0]).toMatchObject({
      actorId,
      targetId: accountId,
      workspaceId: workspace.id,
    });
    expect(after.sessions.map((row) => row.workspace_id)).toEqual([
      "untouched-workspace",
    ]);
    expect(after.invitations.map((row) => row.workspace_id)).toEqual([
      "untouched-workspace",
    ]);
    if (operation === "PATCH") {
      expect(after.membership[0]).toMatchObject({ role: "admin", disabled: 1 });
      expect(after.account[0]).toMatchObject({
        failed_count: 0,
        locked_until: null,
      });
    } else expect(after.membership).toHaveLength(0);
  });
}
