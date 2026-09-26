import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "particl-accounts-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
const password = "Unique-studio-password-43";

async function owner(label: string) {
  const { createAccount } = await import("../../lib/platform");
  const { hashPassword } = await import("../../lib/auth");
  return createAccount(`${label}@example.test`, label, hashPassword(password));
}
async function workspace(label: string) {
  const { requestWorkspace, resumeWorkspace } =
    await import("../../lib/workspaceProvisioning");
  const user = await owner(label),
    requestId = await requestWorkspace({ owner: user, name: label });
  const result = await resumeWorkspace(requestId, user.id);
  expect(
    result.workspace,
    result.provisioning?.error ?? "workspace ready",
  ).toBeTruthy();
  return { user, requestId, ws: result.workspace! };
}
async function invite(workspaceId: string, email: string, code: string) {
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({
    sql: `INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,'Team','member',?,?)`,
    args: [code, workspaceId, email, Date.now(), Date.now() + 3600_000],
  });
}

test("email proof creates an isolated zero-grant workspace once and preserves paid plan intent", async () => {
  const { beginSignup, verifySignup, signupNext } =
    await import("../../lib/signupRegistration");
  const { platformDb } = await import("../../lib/platform");
  const { resumeWorkspace } = await import("../../lib/workspaceProvisioning");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const reg = await beginSignup(
    {
      name: "Customer",
      email: "Customer@example.test",
      workspace: "Customer house",
      password,
      planId: "agency",
      cadence: "annual",
    },
    "source-direct",
  );
  const p = platformDb();
  expect(
    (
      await p.execute(
        `SELECT * FROM accounts WHERE email='customer@example.test'`,
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await p.execute(
        `SELECT * FROM workspace_provisioning WHERE name='Customer house'`,
      )
    ).rows,
  ).toHaveLength(0);
  const stored = (
    await p.execute(
      `SELECT * FROM signup_registrations WHERE email='customer@example.test'`,
    )
  ).rows[0];
  expect(stored.token_hash).not.toBe(reg.token);
  expect(stored.password_hash).not.toBe(password);
  const verified = await verifySignup(reg.token);
  expect(signupNext(verified)).toBe(
    "/billing?plan=agency&cadence=annual&onboarding=1",
  );
  await expect(verifySignup(reg.token)).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await verifySignup(
        reg.token,
        verified.owner.id,
        await (
          await import("../../lib/platform")
        ).createPlatformSession(verified.owner.id, null),
      )
    ).requestId,
  ).toBe(verified.requestId);
  await expect(
    resumeWorkspace(verified.requestId, "different-owner"),
  ).rejects.toMatchObject({ status: 404 });
  const results = await Promise.all([
    resumeWorkspace(verified.requestId, verified.owner.id),
    resumeWorkspace(verified.requestId, verified.owner.id),
  ]);
  expect(results.some((r) => r.workspace)).toBe(true);
  const ws = (await resumeWorkspace(verified.requestId, verified.owner.id))
    .workspace!;
  expect(ws.planId).toBe("invite");
  expect(
    (
      await p.execute({
        sql: "SELECT * FROM workspaces WHERE owner_id=?",
        args: [verified.owner.id],
      })
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await p.execute({
        sql: "SELECT * FROM credit_grants WHERE workspace_id=?",
        args: [ws.id],
      })
    ).rows,
  ).toHaveLength(0);
  await runInTenant(ws, async () => {
    await ready();
    expect(
      (await db().execute("SELECT id FROM users")).rows.map((r) => r.id),
    ).toEqual([verified.owner.id]);
  });
  const other = await workspace("Isolation");
  expect(other.ws.dbUrl).not.toBe(ws.dbUrl);
  await runInTenant(other.ws, async () => {
    await ready();
    expect(
      (await db().execute("SELECT id FROM users")).rows.map((r) => r.id),
    ).toEqual([other.user.id]);
  });
});

test("approved invitation survives provisioning failure and grants welcome credits exactly once", async () => {
  const { accountDbReady } = await import("../../lib/accountDb");
  const { platformDb } = await import("../../lib/platform");
  const { acceptSignupInvitation } =
    await import("../../lib/signupRegistration");
  const { resumeWorkspace, approvedWelcomeCredits } =
    await import("../../lib/workspaceProvisioning");
  await accountDbReady();
  const p = platformDb();
  await p.execute({
    sql: `INSERT INTO signup_invites(code,email,name,created_at,expires_at) VALUES('approved','approved@example.test','Approved',?,?)`,
    args: [Date.now(), Date.now() + 3600_000],
  });
  const input = {
    code: "approved",
    name: "Approved",
    email: "approved@example.test",
    workspace: "Approved studio",
    password,
  };
  const accepted = await acceptSignupInvitation(input);
  const invalidFolder = path.join(dir, "not-a-directory");
  writeFileSync(invalidFolder, "x");
  process.env.WORKSPACE_DB_DIRECTORY = invalidFolder;
  try {
    const failed = await resumeWorkspace(accepted.requestId, accepted.owner.id);
    expect(failed.provisioning?.state).toBe("failed");
    expect(
      (
        await p.execute({
          sql: "SELECT id FROM accounts WHERE id=?",
          args: [accepted.owner.id],
        })
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await p.execute({
          sql: "SELECT * FROM workspaces WHERE owner_id=?",
          args: [accepted.owner.id],
        })
      ).rows,
    ).toHaveLength(0);
  } finally {
    process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
  }
  const replay = await acceptSignupInvitation(
    input,
    accepted.owner.id,
    await (
      await import("../../lib/platform")
    ).createPlatformSession(accepted.owner.id, null),
  );
  expect(replay.requestId).toBe(accepted.requestId);
  const ws = (await resumeWorkspace(replay.requestId, replay.owner.id))
    .workspace!;
  expect(ws).toBeTruthy();
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(ws, async () =>
    expect((await db().execute("SELECT id FROM projects")).rows).toHaveLength(
      0,
    ),
  );
  await resumeWorkspace(replay.requestId, replay.owner.id);
  const grants = (
    await p.execute({
      sql: "SELECT * FROM credit_grants WHERE workspace_id=?",
      args: [ws.id],
    })
  ).rows;
  expect(grants).toHaveLength(1);
  expect(grants[0].id).toBe("welcome:" + ws.id);
  expect(Number(grants[0].credits)).toBe(await approvedWelcomeCredits());
  const request = (
    await p.execute({
      sql: "SELECT * FROM workspace_provisioning WHERE request_id=?",
      args: [replay.requestId],
    })
  ).rows[0];
  expect(Number(request.attempts)).toBe(2);
  expect(
    readdirSync(path.join(dir, "tenants")).filter(
      (f) => f === String(request.db_name) + ".db",
    ),
  ).toHaveLength(1);
});

test("workspace capacity is reserved atomically and same-name retries do not consume capacity", async () => {
  const { requestWorkspace } = await import("../../lib/workspaceProvisioning");
  const user = await owner("Capacity");
  const results = await Promise.allSettled(
    Array.from({ length: 7 }, (_, i) =>
      requestWorkspace({ owner: user, name: "House " + i }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  const first = results[0];
  expect(first.status).toBe("fulfilled");
  if (first.status === "fulfilled")
    expect(await requestWorkspace({ owner: user, name: "House 0" })).toBe(
      first.value,
    );
});

test("database create response loss recovers the immutable database name without a second creation", async () => {
  const { provisionTenantDatabase } = await import("../../lib/provision");
  const originalFetch = globalThis.fetch;
  process.env.TURSO_API_TOKEN = "mock-token";
  process.env.TURSO_ORG = "mock-org";
  let exists = false,
    creates = 0,
    tokens = 0;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/auth/tokens")) {
      tokens++;
      return Response.json({ jwt: "mock-database-token" });
    }
    if (init?.method === "POST") {
      creates++;
      exists = true;
      throw new Error("Lost response after resource creation");
    }
    return exists
      ? Response.json({ database: { Hostname: "stable.mock.turso.io" } })
      : Response.json({ error: "Not found" }, { status: 404 });
  };
  try {
    await expect(
      provisionTenantDatabase("customer", "particl-stable"),
    ).rejects.toThrow("Lost response");
    expect(await provisionTenantDatabase("customer", "particl-stable")).toEqual(
      {
        url: "libsql://stable.mock.turso.io",
        token: "mock-database-token",
        name: "particl-stable",
      },
    );
    expect(creates).toBe(1);
    expect(tokens).toBe(1);
    expect(
      urls.filter((u) => u.endsWith("/databases/particl-stable")),
    ).toHaveLength(2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TURSO_API_TOKEN;
    delete process.env.TURSO_ORG;
  }
});

test("concurrent invitation accepts cannot exceed seats; an existing owner is never demoted", async () => {
  const { acceptWorkspaceInvitation } =
    await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Seats");
  await invite(ws.id, "already@example.test", "seat-existing");
  await acceptWorkspaceInvitation({
    acceptedPolicy: true,
    code: "seat-existing",
    password,
  });
  await invite(ws.id, "seat-a@example.test", "seat-a");
  await invite(ws.id, "seat-b@example.test", "seat-b");
  const results = await Promise.allSettled(
    ["seat-a", "seat-b"].map((code) =>
      acceptWorkspaceInvitation({ acceptedPolicy: true, code, password }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const denied = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  expect(denied.reason.status).toBe(402);
  const p = platformDb();
  expect(
    Number(
      (
        await p.execute({
          sql: "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND disabled=0",
          args: [ws.id],
        })
      ).rows[0].n,
    ),
  ).toBe(3);
  expect(
    (
      await p.execute(
        `SELECT id FROM accounts WHERE email IN ('seat-a@example.test','seat-b@example.test')`,
      )
    ).rows,
  ).toHaveLength(1);
  await invite(ws.id, user.email, "owner-stale");
  await acceptWorkspaceInvitation({
    acceptedPolicy: true,
    code: "owner-stale",
    signedInAccountId: user.id,
    signedInSession: await (
      await import("../../lib/platform")
    ).createPlatformSession(user.id, null),
  });
  expect(
    (
      await p.execute({
        sql: "SELECT role FROM memberships WHERE workspace_id=? AND account_id=?",
        args: [ws.id, user.id],
      })
    ).rows[0].role,
  ).toBe("owner");
  expect(
    (
      await acceptWorkspaceInvitation({
        acceptedPolicy: true,
        code: "owner-stale",
        signedInAccountId: user.id,
        signedInSession: await (
          await import("../../lib/platform")
        ).createPlatformSession(user.id, null),
      })
    ).accountId,
  ).toBe(user.id);
});

test("a confirmed paid period permits team seats and lapse restores the existing Invite cap", async () => {
  const { acceptWorkspaceInvitation } =
    await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { applyPaidSubscriptionPeriod } =
    await import("../../lib/billingLedger");
  const { ws } = await workspace("Paid team");
  const at = Date.now();
  await applyPaidSubscriptionPeriod(
    {
      workspaceId: ws.id,
      provider: "test",
      subscriptionId: "seat-sub",
      invoiceId: "seat-invoice",
      planId: "studio",
      interval: "month",
      includedCredits: 400,
      periodStart: at - 1000,
      periodEnd: at + 3600_000,
      paidUsd: 49,
    },
    at,
  );
  for (let i = 0; i < 4; i++) {
    await invite(ws.id, `paid-${i}@example.test`, `paid-${i}`);
    await acceptWorkspaceInvitation({
      acceptedPolicy: true,
      code: `paid-${i}`,
      password,
    });
  }
  await platformDb().execute(
    `UPDATE billing_paid_periods SET period_end=0 WHERE invoice_id='seat-invoice'`,
  );
  await invite(ws.id, "paid-after@example.test", "paid-after");
  await expect(
    acceptWorkspaceInvitation({
      acceptedPolicy: true,
      code: "paid-after",
      password,
    }),
  ).rejects.toMatchObject({ status: 402 });
});

test("revoked membership and deleted accounts or workspaces invalidate a still-live tenant bearer", async () => {
  const { callerFromToken, mintTokenSecret, tokenHash } =
    await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { user, ws } = await workspace("Token owner");
  const raw = await runInTenant(ws, async () => {
    const raw = mintTokenSecret();
    await db().execute({
      sql: `INSERT INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES('token',?,'Read',?,'read',?)`,
      args: [tokenHash(raw), user.id, Date.now()],
    });
    return raw;
  });
  const p = platformDb();
  expect((await callerFromToken(raw))?.user?.owner).toBe(true);
  await p.execute({
    sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?",
    args: [ws.id, user.id],
  });
  expect(await callerFromToken(raw)).toBeNull();
  await p.execute({
    sql: "UPDATE memberships SET disabled=0,role=? WHERE workspace_id=? AND account_id=?",
    args: ["member", ws.id, user.id],
  });
  expect((await callerFromToken(raw))?.user?.owner).toBe(false);
  await p.execute({
    sql: "UPDATE accounts SET deleted_at=? WHERE id=?",
    args: [Date.now(), user.id],
  });
  expect(await callerFromToken(raw)).toBeNull();
  await p.execute({
    sql: "UPDATE accounts SET deleted_at=NULL WHERE id=?",
    args: [user.id],
  });
  await p.execute({
    sql: "UPDATE workspaces SET deleted_at=? WHERE id=?",
    args: [Date.now(), ws.id],
  });
  expect(await callerFromToken(raw)).toBeNull();
  await p.execute({
    sql: "UPDATE workspaces SET deleted_at=NULL WHERE id=?",
    args: [ws.id],
  });
  await p.execute({
    sql: "DELETE FROM memberships WHERE workspace_id=? AND account_id=?",
    args: [ws.id, user.id],
  });
  expect(await callerFromToken(raw)).toBeNull();
});

test("owner read and render tokens cannot administer accounts; only render scope may render", async () => {
  const { requireAdmin, requireOwner, requireSuperAdmin, requireRender } =
    await import("../../lib/auth");
  const { runInTenant } = await import("../../lib/tenant");
  const { user, ws } = await workspace("Guard owner");
  const tenantUser = {
    ...user,
    role: "admin" as const,
    owner: true,
    disabled: false,
    lastSeen: null,
    createdAt: 0,
  };
  for (const scope of ["read", "render"] as const)
    await runInTenant(
      ws,
      async () => {
        expect((await requireAdmin()).response?.status).toBe(403);
        expect((await requireOwner()).response?.status).toBe(403);
        expect((await requireSuperAdmin()).response?.status).toBe(403);
        expect((await requireRender()).response?.status).toBe(
          scope === "read" ? 403 : undefined,
        );
      },
      {
        user: tenantUser,
        token: { id: "guard", name: "Token", scope, capUsd: null },
      },
    );
  await runInTenant(
    ws,
    async () => {
      expect((await requireAdmin()).user?.id).toBe(user.id);
      expect((await requireOwner()).user?.id).toBe(user.id);
    },
    { user: tenantUser },
  );
});

test("tenant mirror failure retains a repairable accepted membership and never consumes another seat", async () => {
  const { acceptWorkspaceInvitation, repairPendingMemberships } =
    await import("../../lib/teamInvitations");
  const { platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { ws } = await workspace("Mirror repair");
  await invite(ws.id, "repair@example.test", "repair-invite");
  const client = await runInTenant(ws, async () => db()),
    execute = client.execute.bind(client);
  client.execute = async (statement) => {
    const sql = typeof statement === "string" ? statement : statement.sql;
    if (sql.includes("INSERT INTO users"))
      throw new Error("Temporary tenant connection failure");
    return execute(statement);
  };
  let accountId = "";
  try {
    accountId = (
      await acceptWorkspaceInvitation({
        acceptedPolicy: true,
        code: "repair-invite",
        password,
      })
    ).accountId;
    expect(
      (
        await platformDb().execute({
          sql: "SELECT * FROM membership_mirrors WHERE workspace_id=? AND account_id=?",
          args: [ws.id, accountId],
        })
      ).rows,
    ).toHaveLength(1);
  } finally {
    client.execute = execute;
  }
  await repairPendingMemberships(accountId);
  expect(
    (
      await platformDb().execute({
        sql: "SELECT * FROM membership_mirrors WHERE workspace_id=? AND account_id=?",
        args: [ws.id, accountId],
      })
    ).rows,
  ).toHaveLength(0);
  await runInTenant(ws, async () =>
    expect(
      (
        await db().execute({
          sql: "SELECT id FROM users WHERE id=?",
          args: [accountId],
        })
      ).rows,
    ).toHaveLength(1),
  );
  expect(
    (
      await acceptWorkspaceInvitation({
        acceptedPolicy: true,
        code: "repair-invite",
        signedInAccountId: accountId,
        signedInSession: await (
          await import("../../lib/platform")
        ).createPlatformSession(accountId, null),
      })
    ).accountId,
  ).toBe(accountId);
  expect(
    Number(
      (
        await platformDb().execute({
          sql: "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=?",
          args: [ws.id],
        })
      ).rows[0].n,
    ),
  ).toBe(2);
});

test("concurrent member reactivation and invite acceptance share one seat reservation", async () => {
  const { acceptWorkspaceInvitation, ensureMemberSeat } =
    await import("../../lib/teamInvitations");
  const { accountTransaction } = await import("../../lib/accountDb");
  const { platformDb, getPlatformLayer } = await import("../../lib/platform");
  const { ws } = await workspace("Reactivate");
  await invite(ws.id, "reactivate-a@example.test", "reactivate-a");
  const a = await acceptWorkspaceInvitation({
    acceptedPolicy: true,
    code: "reactivate-a",
    password,
  });
  await platformDb().execute({
    sql: "UPDATE memberships SET disabled=1 WHERE workspace_id=? AND account_id=?",
    args: [ws.id, a.accountId],
  });
  await invite(ws.id, "reactivate-b@example.test", "reactivate-b");
  await acceptWorkspaceInvitation({
    acceptedPolicy: true,
    code: "reactivate-b",
    password,
  });
  await invite(ws.id, "reactivate-c@example.test", "reactivate-c");
  const layer = await getPlatformLayer();
  const results = await Promise.allSettled([
    accountTransaction(async (tx) => {
      await ensureMemberSeat(tx, ws, layer);
      await tx.execute({
        sql: "UPDATE memberships SET disabled=0 WHERE workspace_id=? AND account_id=?",
        args: [ws.id, a.accountId],
      });
    }),
    acceptWorkspaceInvitation({
      acceptedPolicy: true,
      code: "reactivate-c",
      password,
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.status,
  ).toBe(402);
  expect(
    Number(
      (
        await platformDb().execute({
          sql: "SELECT COUNT(*) AS n FROM memberships WHERE workspace_id=? AND disabled=0",
          args: [ws.id],
        })
      ).rows[0].n,
    ),
  ).toBe(3);
});

test("verification token rotation and concurrent verification keep one account and one request", async () => {
  const { beginSignup, resendSignup, verifySignup } =
    await import("../../lib/signupRegistration");
  const { platformDb } = await import("../../lib/platform");
  const reg = await beginSignup(
    {
      name: "Proof",
      email: "proof@example.test",
      workspace: "Proof house",
      password,
    },
    "proof-source",
  );
  await platformDb().execute(
    `DELETE FROM account_action_limits WHERE key LIKE 'signup-email-minute:%'`,
  );
  const rotated = await resendSignup(reg.email, "proof-resend");
  expect(rotated?.token).not.toBe(reg.token);
  await expect(verifySignup(reg.token)).rejects.toMatchObject({ status: 410 });
  const results = await Promise.allSettled([
    verifySignup(rotated!.token),
    verifySignup(rotated!.token),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.status,
  ).toBe(409);
  expect(
    (
      await platformDb().execute(
        `SELECT id FROM accounts WHERE email='proof@example.test'`,
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await platformDb().execute(
        `SELECT request_id FROM workspace_provisioning WHERE name='Proof house'`,
      )
    ).rows,
  ).toHaveLength(1);
  await expect(resendSignup(reg.email, "proof-resend")).rejects.toMatchObject({
    status: 429,
  });
});
