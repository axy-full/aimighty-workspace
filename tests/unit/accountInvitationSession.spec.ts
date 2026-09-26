import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { totpAt } from "../../lib/totp";

const directory = mkdtempSync(join(tmpdir(), "particl-invitation-security-"));
process.env.PLATFORM_DATABASE_URL = `file:${join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${join(directory, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = join(directory, "tenants");
process.env.KEYRING_SECRET = "isolated-invitation-security-secret";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;
const password = "Invitation security fixture passphrase 2026";

async function fixture(id: string, enrolled = true) {
  const p = await import("../../lib/platform"),
    auth = await import("../../lib/auth"),
    security = await import("../../lib/accountSecurity"),
    provisioning = await import("../../lib/workspaceProvisioning");
  await p.platformReady();
  const account = await p.createAccount(
    `${id}@example.test`,
    id,
    auth.hashPassword(password),
  );
  const requestId = await provisioning.requestWorkspace({
    owner: account,
    name: id,
  });
  const workspace = (await provisioning.resumeWorkspace(requestId, account.id))
    .workspace!;
  expect(workspace).toBeTruthy();
  let session = await p.createPlatformSession(account.id, workspace.id),
    secret = "";
  if (enrolled) {
    const started = await security.changeAccountSecurity({
      accountId: account.id,
      session,
      password,
      action: "begin",
    });
    secret = started.setup!.secret;
    // Pin the clock for enrolment, as accountSecurity.spec does: a
    // previous-step code computed just before a 30 s boundary is two steps
    // old by the time the server checks it, and enrolment then refuses it.
    const clock = Date.now,
      enrollmentAt = clock();
    Date.now = () => enrollmentAt;
    let enabled: Awaited<ReturnType<typeof security.changeAccountSecurity>>;
    try {
      enabled = await security.changeAccountSecurity({
        accountId: account.id,
        session,
        password,
        action: "enable",
        code: totpAt(secret, enrollmentAt - 30_000),
      });
    } finally {
      Date.now = clock;
    }
    session = enabled.session!;
  }
  return { p, auth, account, session, workspace, secret };
}

/** Only Next's request cookie/context boundary is replaced. The actual route,
 * security transactions, invitation services, local provisioning and audit run. */
async function route(
  name: "accept" | "signup" | "verify" | "login",
  session?: string,
  options: { revokeAfterCapture?: boolean; failedCleanup?: boolean } = {},
) {
  const p = await import("../../lib/platform"),
    auth = await import("../../lib/auth");
  const jar = {
    value: session,
    writes: [] as string[],
    get: () => (jar.value ? { value: jar.value } : undefined),
    set: (_name: string, value: string) => {
      jar.value = value;
      jar.writes.push(value);
    },
  };
  const dependencies: Record<string, unknown> = {
    "@/lib/recovery": await import("../../lib/recovery"),
    "next/server": createRequire(resolve("package.json"))("next/server"),
    "next/headers": { cookies: async () => jar },
    "@/lib/auth": {
      ...auth,
      currentContext: async () => {
        const found = jar.value ? await p.sessionLookup(jar.value) : null;
        if (found && options.revokeAfterCapture)
          await p.destroyPlatformSession(jar.value!);
        return found
          ? {
              user: {
                id: String(found.account.id),
                email: String(found.account.email),
              },
            }
          : null;
      },
      ...(options.failedCleanup
        ? {
            clearFailures: async () => {
              throw Error("counter reset unavailable");
            },
          }
        : {}),
    },
    "@/lib/platform": p,
    "@/lib/accountDb": await import("../../lib/accountDb"),
    "@/lib/accountSecurity": await import("../../lib/accountSecurity"),
    "@/lib/accountInvitationSession":
      await import("../../lib/accountInvitationSession"),
    "@/lib/teamInvitations": await import("../../lib/teamInvitations"),
    "@/lib/signupRegistration": await import("../../lib/signupRegistration"),
    "@/lib/workspaceProvisioning":
      await import("../../lib/workspaceProvisioning"),
    "@/lib/policyAccept": await import("../../lib/policyAccept"),
    // No mail on this deployment: an invitation link alone may make an account.
    "@/lib/mail": {
      mailConfigured: () => false,
      inviteOrigin: () => "http://particl.test",
      inviteEmail: () => ({ subject: "", text: "", html: "" }),
      sendMail: async () => {
        throw Error("Unit tests never send mail");
      },
    },
  };
  const compiled = ts.transpileModule(
    readFileSync(resolve(`app/api/auth/${name}/route.ts`), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const evaluated = {
    exports: {} as { POST(request: Request): Promise<Response> },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies))
        throw Error(`Unexpected route import ${name}`);
      return dependencies[name];
    },
    evaluated,
    evaluated.exports,
  );
  return {
    jar,
    post: (body: unknown) =>
      evaluated.exports.POST(
        new Request(`http://particl.test/api/auth/${name}`, {
          method: "POST",
          headers: {
            Origin: "http://particl.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
  };
}

test("enrolled account accepts and replays a team invitation using the same verified cookie", async () => {
  const f = await fixture("mfa-team"),
    target = await fixture("team-target", false);
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,?,'member',?,?)",
      args: [
        "mfa-team-invite",
        target.workspace.id,
        f.account.email,
        "Member",
        Date.now(),
        Date.now() + 60_000,
      ],
    });
  const handler = await route("accept", f.session);
  for (let i = 0; i < 2; i++) {
    const response = await handler.post({ code: "mfa-team-invite" });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  expect(handler.jar.writes).toEqual([]);
  expect((await f.p.sessionLookup(f.session))?.workspaceId).toBe(
    target.workspace.id,
  );
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT account_id FROM memberships WHERE account_id=? AND workspace_id=?",
          args: [f.account.id, target.workspace.id],
        })
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT token_hash FROM p_sessions WHERE account_id=?",
          args: [f.account.id],
        })
    ).rows,
  ).toHaveLength(1);
});

test("revocation after request capture prevents team membership and invite consumption", async () => {
  const f = await fixture("revoked-team"),
    target = await fixture("revoked-target", false);
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_at,expires_at) VALUES(?,?,?,?,'member',?,?)",
      args: [
        "revoked-team-invite",
        target.workspace.id,
        f.account.email,
        "Member",
        Date.now(),
        Date.now() + 60_000,
      ],
    });
  const handler = await route("accept", f.session, {
    revokeAfterCapture: true,
  });
  expect((await handler.post({ code: "revoked-team-invite" })).status).toBe(
    401,
  );
  expect(
    (
      await f.p
        .platformDb()
        .execute(
          "SELECT used_at FROM workspace_invites WHERE code='revoked-team-invite'",
        )
    ).rows[0].used_at,
  ).toBeNull();
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT account_id FROM memberships WHERE account_id=? AND workspace_id=?",
          args: [f.account.id, target.workspace.id],
        })
    ).rows,
  ).toHaveLength(0);
  expect(handler.jar.writes).toEqual([]);
});

test("enrolled signup invitation creates one workspace and grant while replay keeps the verified session", async () => {
  const f = await fixture("mfa-signup");
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO signup_invites(code,email,name,created_at,expires_at) VALUES(?,?,?,?,?)",
      args: [
        "mfa-signup-invite",
        f.account.email,
        f.account.name,
        Date.now(),
        Date.now() + 60_000,
      ],
    });
  const handler = await route("signup", f.session),
    input = {
      code: "mfa-signup-invite",
      email: f.account.email,
      name: f.account.name,
      workspace: "Additional MFA house",
      password,
      accept: true,
    };
  const response = await handler.post(input);
  expect(response.status, await response.clone().text()).toBe(200);
  const first = await response.json();
  const replay = await handler.post(input);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect((await replay.json()).workspace.id).toBe(first.workspace.id);
  expect(handler.jar.writes).toEqual([]);
  expect((await f.p.sessionLookup(f.session))?.workspaceId).toBe(
    first.workspace.id,
  );
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT id FROM credit_grants WHERE workspace_id=? AND kind='welcome'",
          args: [first.workspace.id],
        })
    ).rows,
  ).toHaveLength(1);
});

test("revoked captured session cannot consume an existing-account signup invitation", async () => {
  const f = await fixture("revoked-signup");
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO signup_invites(code,email,name,created_at,expires_at) VALUES(?,?,?,?,?)",
      args: [
        "revoked-signup-invite",
        f.account.email,
        f.account.name,
        Date.now(),
        Date.now() + 60_000,
      ],
    });
  const handler = await route("signup", f.session, {
    revokeAfterCapture: true,
  });
  expect(
    (
      await handler.post({
        code: "revoked-signup-invite",
        email: f.account.email,
        name: f.account.name,
        workspace: "Rejected house",
        password,
        accept: true,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.p
        .platformDb()
        .execute(
          "SELECT used_at FROM signup_invites WHERE code='revoked-signup-invite'",
        )
    ).rows[0].used_at,
  ).toBeNull();
  expect(
    (
      await f.p
        .platformDb()
        .execute(
          "SELECT request_id FROM workspace_provisioning WHERE welcome_source='signup-invite:revoked-signup-invite'",
        )
    ).rows,
  ).toHaveLength(0);
});

test("verified signup resumption preserves MFA and requires a live session for replay", async () => {
  const f = await fixture("verified-mfa"),
    registration = await import("../../lib/signupRegistration");
  const token = "v".repeat(43);
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO signup_registrations(email,name,password_hash,workspace_name,plan_id,cadence,token_hash,expires_at,verified_at,account_id,request_id,created_at,updated_at) VALUES(?,?,?,'Verified house','agency','annual',?,?,?,?,?,?,?)",
      args: [
        f.account.email,
        f.account.name,
        "!",
        f.auth.tokenHash(token),
        Date.now() + 60_000,
        Date.now(),
        f.account.id,
        "verified-request-fixture",
        Date.now(),
        Date.now(),
      ],
    });
  const provisioning = await import("../../lib/workspaceProvisioning");
  const requestId = await provisioning.requestWorkspace({
    owner: f.account,
    name: "Verified house",
    requestKey: "verified-fixture",
  });
  await f.p
    .platformDb()
    .execute({
      sql: "UPDATE signup_registrations SET request_id=? WHERE email=?",
      args: [requestId, f.account.email],
    });
  const handler = await route("verify", f.session);
  for (let i = 0; i < 2; i++)
    expect((await handler.post({ token })).status).toBe(200);
  expect(handler.jar.writes).toEqual([]);
  expect(await f.p.sessionLookup(f.session)).not.toBeNull();
  await f.p.destroyPlatformSession(f.session);
  await expect(
    registration.verifySignup(token, f.account.id, f.session),
  ).rejects.toMatchObject({ status: 401 });
});

test("a revoked captured verification session cannot start a pending workspace request", async () => {
  const f = await fixture("revoked-verify"),
    provisioning = await import("../../lib/workspaceProvisioning");
  const token = "r".repeat(43),
    requestId = await provisioning.requestWorkspace({
      owner: f.account,
      name: "Unstarted verified house",
      requestKey: "unstarted-verify",
    });
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO signup_registrations(email,name,password_hash,workspace_name,plan_id,cadence,token_hash,expires_at,verified_at,account_id,request_id,created_at,updated_at) VALUES(?,?,?,'Unstarted verified house','studio','monthly',?,?,?,?,?,?,?)",
      args: [
        f.account.email,
        f.account.name,
        "!",
        f.auth.tokenHash(token),
        Date.now() + 60_000,
        Date.now(),
        f.account.id,
        requestId,
        Date.now(),
        Date.now(),
      ],
    });
  const handler = await route("verify", f.session, {
    revokeAfterCapture: true,
  });
  expect((await handler.post({ token })).status).toBe(401);
  expect(handler.jar.writes).toEqual([]);
  const row = (
    await f.p
      .platformDb()
      .execute({
        sql: "SELECT state,attempts,workspace_id FROM workspace_provisioning WHERE request_id=?",
        args: [requestId],
      })
  ).rows[0];
  expect(row.state).toBe("pending");
  expect(Number(row.attempts)).toBe(0);
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT id FROM workspaces WHERE id=?",
          args: [row.workspace_id],
        })
    ).rows,
  ).toHaveLength(0);
});

test("first signup verification still issues a session and can safely resume with that cookie", async () => {
  const registration = await import("../../lib/signupRegistration"),
    p = await import("../../lib/platform");
  const started = await registration.beginSignup(
    {
      email: "new-route-verify@example.test",
      name: "New account",
      password,
      workspace: "New route house",
    },
    "new-route-verify-source",
  );
  const handler = await route("verify");
  const response = await handler.post({ token: started.token });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(handler.jar.writes).toHaveLength(1);
  const session = handler.jar.writes[0];
  expect(await p.sessionLookup(session)).not.toBeNull();
  const replay = await handler.post({ token: started.token });
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(handler.jar.writes).toEqual([session]);
});

test("login delivers an issued MFA session despite counter cleanup failure and repairs pending tenant mirrors", async () => {
  const f = await fixture("login-housekeeping");
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(f.workspace, () =>
    db().execute({ sql: "DELETE FROM users WHERE id=?", args: [f.account.id] }),
  );
  await f.p
    .platformDb()
    .execute({
      sql: "INSERT INTO membership_mirrors(workspace_id,account_id,updated_at) VALUES(?,?,?)",
      args: [f.workspace.id, f.account.id, Date.now()],
    });
  const handler = await route("login", undefined, { failedCleanup: true });
  const response = await handler.post({
    email: f.account.email,
    password,
    code: totpAt(f.secret, Date.now()),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(handler.jar.writes).toHaveLength(1);
  expect(await f.p.sessionLookup(handler.jar.writes[0])).not.toBeNull();
  expect(
    (
      await f.p
        .platformDb()
        .execute({
          sql: "SELECT account_id FROM membership_mirrors WHERE account_id=?",
          args: [f.account.id],
        })
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await runInTenant(f.workspace, () =>
        db().execute({
          sql: "SELECT id FROM users WHERE id=?",
          args: [f.account.id],
        }),
      )
    ).rows,
  ).toHaveLength(1);
});
