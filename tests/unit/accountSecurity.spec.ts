import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase32, matchingTotpCounter, totpAt } from "../../lib/totp";
const directory = mkdtempSync(join(tmpdir(), "particl-account-security-"));
process.env.PLATFORM_DATABASE_URL = `file:${join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${join(directory, "legacy.db")}`;
process.env.KEYRING_SECRET = "isolated-account-security-test-secret";
process.env.ENGINE_MOCK = "1";

const password = "Account security test passphrase 2026";
async function fixture(id: string) {
  const p = await import("../../lib/platform"),
    auth = await import("../../lib/auth"),
    security = await import("../../lib/accountSecurity");
  await p.platformReady();
  const client = p.platformDb(),
    passwordHash = auth.hashPassword(password);
  await client.execute({
    sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    args: [id, id + "@example.test", id, passwordHash, Date.now()],
  });
  const session = await p.createPlatformSession(id, null);
  return { id, session, passwordHash, client, p, auth, security };
}
async function enrolled(id: string) {
  const f = await fixture(id);
  const started = await f.security.changeAccountSecurity({
    accountId: id,
    session: f.session,
    password,
    action: "begin",
  });
  if (!started.setup) throw Error("Expected setup");
  const secret = started.setup.secret;
  // Keep the fixture's previous-step code and verification on one clock
  // instant. Otherwise the password check can cross a 30-second boundary
  // and make that code two steps old before the enrollment transaction.
  const clock = Date.now, enrollmentAt = clock();
  let result: Awaited<ReturnType<typeof f.security.changeAccountSecurity>>;
  Date.now = () => enrollmentAt;
  try {
    result = await f.security.changeAccountSecurity({
      accountId: id,
      session: f.session,
      password,
      action: "enable",
      code: totpAt(secret, enrollmentAt - 30_000),
    });
  } finally {
    Date.now = clock;
  }
  if (!result.session || !result.recoveryCodes)
    throw Error("Expected rotated session and recovery codes");
  return {
    ...f,
    oldSession: f.session,
    session: result.session,
    codes: result.recoveryCodes,
    secret,
  };
}

test("TOTP matches RFC6238 SHA1 vectors including dates beyond2038 and rejects replay/outside window", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890"));
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    expect(totpAt(secret, seconds * 1000, 8)).toBe(expected);
  const at = 1_800_000_000_000,
    counter = Math.floor(at / 30_000),
    code = totpAt(secret, at);
  expect(matchingTotpCounter(secret, code, at, counter - 1)).toBe(counter);
  expect(matchingTotpCounter(secret, code, at, counter)).toBeNull();
  expect(
    matchingTotpCounter(secret, totpAt(secret, at - 60_000), at, -1),
  ).toBeNull();
});

test("enrollment verifies possession, binds to its session, encrypts secret and rotates every previous session", async () => {
  const f = await fixture("enrollment"),
    other = await f.p.createPlatformSession(f.id, null);
  const started = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "begin",
  });
  if (!started.setup) throw Error("Missing setup");
  const secret = started.setup.secret;
  const pending = (
    await f.client.execute({
      sql: "SELECT pending_enc FROM account_security WHERE account_id=?",
      args: [f.id],
    })
  ).rows[0];
  expect(String(pending.pending_enc)).not.toContain(secret);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: other,
      password,
      action: "enable",
      code: totpAt(secret, Date.now()),
    }),
  ).rejects.toThrow(/expired or changed/);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "enable",
      code: "wrong",
    }),
  ).rejects.toThrow(/six-digit/);
  const result = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "enable",
    code: totpAt(secret, Date.now()),
  });
  expect(result.recoveryCodes).toHaveLength(10);
  expect(new Set(result.recoveryCodes).size).toBe(10);
  expect(await f.p.sessionLookup(f.session)).toBeNull();
  expect(await f.p.sessionLookup(other)).toBeNull();
  expect(await f.p.sessionLookup(result.session!)).not.toBeNull();
  await expect(f.p.createPlatformSession(f.id, null)).rejects.toThrow(
    /two-step/,
  );
  const response = await f.security.readAccountSecurity(f.id, result.session!);
  expect(response.enabled).toBe(true);
  expect(response.sessions).toHaveLength(1);
  expect(response.sessions[0].current).toBe(true);
  const serialized = JSON.stringify(response);
  for (const value of [secret, result.session!, ...result.recoveryCodes!])
    expect(serialized).not.toContain(value);
});

test("password alone cannot sign in; concurrent use of one authenticator code issues exactly one session", async () => {
  const f = await enrolled("parallel-totp");
  expect(
    await f.security.completePasswordLogin({
      accountId: f.id,
      passwordHash: f.passwordHash,
      code: "",
      deviceLabel: "Browser session",
    }),
  ).toEqual({ mfaRequired: true });
  const before = (
    await f.client.execute({
      sql: "SELECT count(*) n FROM p_sessions WHERE account_id=?",
      args: [f.id],
    })
  ).rows[0].n;
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      f.security.completePasswordLogin({
        accountId: f.id,
        passwordHash: f.passwordHash,
        code: totpAt(f.secret, Date.now()),
        deviceLabel: "Browser session",
      }),
    ),
  );
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    (
      await f.client.execute({
        sql: "SELECT count(*) n FROM p_sessions WHERE account_id=?",
        args: [f.id],
      })
    ).rows[0].n,
  ).toBe(Number(before) + 1);
});

test("recovery codes are hashed, account-bound and single-use under a concurrent race", async () => {
  const f = await enrolled("parallel-recovery"),
    foreign = await enrolled("foreign-recovery");
  const saved = await f.client.execute({
    sql: "SELECT code_hash FROM account_recovery_codes WHERE account_id=?",
    args: [f.id],
  });
  expect(JSON.stringify(saved.rows)).not.toContain(
    f.codes[0].replace(/-/g, ""),
  );
  await expect(
    foreign.security.completePasswordLogin({
      accountId: foreign.id,
      passwordHash: foreign.passwordHash,
      code: f.codes[0],
      deviceLabel: "Browser session",
    }),
  ).rejects.toThrow(/invalid/);
  const outcomes = await Promise.allSettled(
    [1, 2].map(() =>
      f.security.completePasswordLogin({
        accountId: f.id,
        passwordHash: f.passwordHash,
        code: f.codes[0],
        deviceLabel: "Browser session",
      }),
    ),
  );
  expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(9);
});

test("failed security audit rolls back factor consumption, code replacement and session rotation", async () => {
  const f = await enrolled("audit-rollback");
  await f.client.execute(
    "CREATE TRIGGER reject_mfa_change BEFORE INSERT ON security_audit WHEN NEW.action='account.mfa_disabled' BEGIN SELECT RAISE(ABORT,'security receipt failed'); END",
  );
  try {
    await expect(
      f.security.changeAccountSecurity({
        accountId: f.id,
        session: f.session,
        password,
        action: "disable",
        code: f.codes[0],
      }),
    ).rejects.toThrow(/receipt failed/);
  } finally {
    await f.client.execute("DROP TRIGGER reject_mfa_change");
  }
  const state = await f.security.readAccountSecurity(f.id, f.session);
  expect(state.enabled).toBe(true);
  expect(state.recoveryCodesRemaining).toBe(10);
  const changed = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "disable",
    code: f.codes[0],
  });
  expect(await f.p.sessionLookup(f.session)).toBeNull();
  expect(await f.p.sessionLookup(changed.session!)).not.toBeNull();
  expect(
    (await f.security.readAccountSecurity(f.id, changed.session!)).enabled,
  ).toBe(false);
});

test("password reset revokes all sessions and preserves MFA without creating a replacement session", async () => {
  const f = await enrolled("reset-mfa"),
    reset = "mfa-reset-proof";
  await f.client.execute({
    sql: "INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
    args: [f.auth.tokenHash(reset), f.id, Date.now(), Date.now() + 60_000],
  });
  const { resetAccountPassword } = await import("../../lib/passwordReset");
  const result = await resetAccountPassword(
    reset,
    "A replaced account passphrase 2026",
  );
  expect(result.session).toBeNull();
  expect(await f.p.sessionLookup(f.session)).toBeNull();
  await expect(
    f.security.completePasswordLogin({
      accountId: f.id,
      passwordHash: f.passwordHash,
      code: f.codes[0],
      deviceLabel: "Browser session",
    }),
  ).rejects.toThrow(/credentials changed/);
  const current = (
    await f.client.execute({
      sql: "SELECT password_hash FROM accounts WHERE id=?",
      args: [f.id],
    })
  ).rows[0];
  const login = await f.security.completePasswordLogin({
    accountId: f.id,
    passwordHash: String(current.password_hash),
    code: f.codes[0],
    deviceLabel: "Browser session",
  });
  expect(login.mfaRequired).toBe(false);
  expect(await f.p.sessionLookup(login.session!)).not.toBeNull();
});

test("session revocation refuses foreign accounts, stale captured scope and the current session", async () => {
  const f = await fixture("session-owner"),
    foreign = await fixture("session-foreign"),
    other = await f.p.createPlatformSession(f.id, null);
  const list = await f.security.readAccountSecurity(f.id, f.session),
    target = list.sessions.find((value) => !value.current)!;
  const foreignList = await foreign.security.readAccountSecurity(
    foreign.id,
    foreign.session,
  );
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "revoke_session",
      sessionId: foreignList.sessions[0].id,
    }),
  ).rejects.toThrow(/belongs to another/);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "revoke_session",
      sessionId: target.id,
      requestScope: "particl-account-wrong",
    }),
  ).rejects.toThrow(/workspace changed/);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "revoke_session",
      sessionId: list.sessions.find((value) => value.current)!.id,
    }),
  ).rejects.toThrow(/Use Sign out/);
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "revoke_session",
    sessionId: target.id,
  });
  expect(await f.p.sessionLookup(other)).toBeNull();
  expect(await f.p.sessionLookup(f.session)).not.toBeNull();
});

test("factor failures are bounded across fresh password-valid attempts", async () => {
  const f = await enrolled("factor-rate");
  for (let i = 0; i < 8; i++)
    await expect(
      f.security.completePasswordLogin({
        accountId: f.id,
        passwordHash: f.passwordHash,
        code: "invalid",
        deviceLabel: "Browser session",
      }),
    ).rejects.toThrow(/invalid/);
  await expect(
    f.security.completePasswordLogin({
      accountId: f.id,
      passwordHash: f.passwordHash,
      code: f.codes[0],
      deviceLabel: "Browser session",
    }),
  ).rejects.toThrow(/Too many/);
});

test("recovery replacement survives a lost response and keeps unused old codes until confirmed", async () => {
  const f = await enrolled("staged-recovery");
  const other = await f.security.completePasswordLogin({
    accountId: f.id,
    passwordHash: f.passwordHash,
    code: f.codes[0],
    deviceLabel: "Browser session",
  });
  const first = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "rotate_codes",
    code: f.codes[1],
  });
  expect(first.recoveryCodes).toHaveLength(10);
  expect(first.batchId).toBeTruthy();
  const before = await f.security.readAccountSecurity(f.id, f.session);
  expect(before.recoveryCodesRemaining).toBe(8);
  expect(before.pendingRecoveryBatch).toBe(first.batchId);
  // Lost response: same authenticated browser, fresh password, no factor reuse.
  const retry = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "rotate_codes",
  });
  expect(retry.recoveryCodes).toEqual(first.recoveryCodes);
  expect(retry.batchId).toBe(first.batchId);
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(8);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: other.session!,
      password,
      action: "activate_codes",
      batchId: first.batchId,
    }),
  ).rejects.toThrow(/changed/);
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "activate_codes",
    batchId: first.batchId,
  });
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "activate_codes",
    batchId: first.batchId,
  });
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(10);
  await expect(
    f.security.completePasswordLogin({
      accountId: f.id,
      passwordHash: f.passwordHash,
      code: f.codes[2],
      deviceLabel: "Browser session",
    }),
  ).rejects.toThrow(/invalid/);
  expect(
    (
      await f.security.completePasswordLogin({
        accountId: f.id,
        passwordHash: f.passwordHash,
        code: first.recoveryCodes![0],
        deviceLabel: "Browser session",
      })
    ).mfaRequired,
  ).toBe(false);
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "activate_codes",
    batchId: first.batchId,
  });
  expect(
    (await f.security.readAccountSecurity(f.id, f.session))
      .recoveryCodesRemaining,
  ).toBe(9);
  expect(
    (
      await f.client.execute({
        sql: "SELECT codes_enc FROM account_recovery_batches WHERE account_id=?",
        args: [f.id],
      })
    ).rows[0].codes_enc,
  ).toBe("");
});

test("the last recovery-code login can replace backups only in that session with fresh password proof", async () => {
  const f = await enrolled("last-recovery-login");
  const last = f.codes[9];
  await f.client.execute({
    sql: "UPDATE account_recovery_codes SET used_at=? WHERE account_id=? AND code_hash!=?",
    args: [
      Date.now(),
      f.id,
      f.auth.tokenHash(`particl-recovery:${f.id}:${last.replace(/-/g, "")}`),
    ],
  });
  const login = await f.security.completePasswordLogin({
    accountId: f.id,
    passwordHash: f.passwordHash,
    code: last,
    deviceLabel: "Recovery browser",
  });
  const state = await f.security.readAccountSecurity(f.id, login.session!);
  expect(state.recoveryCodesRemaining).toBe(0);
  expect(state.recoveryReplacementAuthorizedUntil).toBeGreaterThan(Date.now());
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: login.session!,
      password,
      action: "disable",
    }),
  ).rejects.toThrow(/code/i);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "rotate_codes",
    }),
  ).rejects.toThrow(/code/i);
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: login.session!,
      password: "incorrect",
      action: "rotate_codes",
    }),
  ).rejects.toThrow(/password/i);
  const batch = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: login.session!,
    password,
    action: "rotate_codes",
  });
  expect(batch.recoveryCodes).toHaveLength(10);
  const replay = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: login.session!,
    password,
    action: "rotate_codes",
  });
  expect(replay.batchId).toBe(batch.batchId);
  expect(replay.recoveryCodes).toEqual(batch.recoveryCodes);
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: login.session!,
    password,
    action: "activate_codes",
    batchId: batch.batchId,
  });
  const after = await f.security.readAccountSecurity(f.id, login.session!);
  expect(after.recoveryCodesRemaining).toBe(10);
  expect(after.recoveryReplacementAuthorizedUntil).toBeNull();
});

test("revoking sessions preserves this browser's pending replacement and refuses consuming its final recovery code", async () => {
  const f = await enrolled("revoke-with-pending-batch");
  const batch = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "rotate_codes",
    code: f.codes[0],
  });
  const rotated = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: f.session,
    password,
    action: "revoke_others",
    code: f.codes[1],
  });
  expect(await f.p.sessionLookup(f.session)).toBeNull();
  expect(
    (await f.security.readAccountSecurity(f.id, rotated.session!))
      .pendingRecoveryBatch,
  ).toBe(batch.batchId);
  const recovered = await f.security.changeAccountSecurity({
    accountId: f.id,
    session: rotated.session!,
    password,
    action: "rotate_codes",
  });
  expect(recovered.recoveryCodes).toEqual(batch.recoveryCodes);
  const last = f.codes[9];
  await f.client.execute({
    sql: "UPDATE account_recovery_codes SET used_at=? WHERE account_id=? AND code_hash!=?",
    args: [
      Date.now(),
      f.id,
      f.auth.tokenHash(`particl-recovery:${f.id}:${last.replace(/-/g, "")}`),
    ],
  });
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: rotated.session!,
      password,
      action: "revoke_others",
      code: last,
    }),
  ).rejects.toThrow(/last code/);
  expect(
    (await f.security.readAccountSecurity(f.id, rotated.session!))
      .recoveryCodesRemaining,
  ).toBe(1);
  expect(await f.p.sessionLookup(rotated.session!)).not.toBeNull();
  await f.security.changeAccountSecurity({
    accountId: f.id,
    session: rotated.session!,
    password,
    action: "activate_codes",
    batchId: batch.batchId,
  });
  expect(
    (await f.security.readAccountSecurity(f.id, rotated.session!))
      .recoveryCodesRemaining,
  ).toBe(10);
});

test("expired recovery replacement authorization does not replace an authenticator", async () => {
  const f = await enrolled("expired-recovery-authorization");
  const login = await f.security.completePasswordLogin({
    accountId: f.id,
    passwordHash: f.passwordHash,
    code: f.codes[0],
    deviceLabel: "Recovery browser",
  });
  await f.client.execute({
    sql: "UPDATE account_recovery_authorizations SET expires_at=0 WHERE account_id=?",
    args: [f.id],
  });
  expect(
    (await f.security.readAccountSecurity(f.id, login.session!))
      .recoveryReplacementAuthorizedUntil,
  ).toBeNull();
  await expect(
    f.security.changeAccountSecurity({
      accountId: f.id,
      session: login.session!,
      password,
      action: "rotate_codes",
    }),
  ).rejects.toThrow(/code/i);
  expect(
    (await f.security.readAccountSecurity(f.id, login.session!))
      .recoveryCodesRemaining,
  ).toBe(9);
});

for (const mode of ["disable", "reset"] as const)
  test(`a pending recovery batch cannot survive ${mode} and new authenticated sessions`, async () => {
    const f = await enrolled("batch-reset-" + mode);
    const batch = await f.security.changeAccountSecurity({
      accountId: f.id,
      session: f.session,
      password,
      action: "rotate_codes",
      code: f.codes[0],
    });
    let session: string,
      activePassword = password;
    if (mode === "disable") {
      const disabled = await f.security.changeAccountSecurity({
        accountId: f.id,
        session: f.session,
        password,
        action: "disable",
        code: f.codes[1],
      });
      session = disabled.session!;
      const setup = await f.security.changeAccountSecurity({
        accountId: f.id,
        session,
        password,
        action: "begin",
      });
      const result = await f.security.changeAccountSecurity({
        accountId: f.id,
        session,
        password,
        action: "enable",
        code: totpAt(setup.setup!.secret, Date.now() - 30_000),
      });
      session = result.session!;
    } else {
      const reset = "pending-batch-password-reset";
      await f.client.execute({
        sql: "INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
        args: [f.auth.tokenHash(reset), f.id, Date.now(), Date.now() + 60000],
      });
      activePassword = "Replaced pending recovery passphrase 2026";
      await (
        await import("../../lib/passwordReset")
      ).resetAccountPassword(reset, activePassword);
      const row = (
        await f.client.execute({
          sql: "SELECT password_hash FROM accounts WHERE id=?",
          args: [f.id],
        })
      ).rows[0];
      session = (
        await f.security.completePasswordLogin({
          accountId: f.id,
          passwordHash: String(row.password_hash),
          code: f.codes[1],
          deviceLabel: "Browser session",
        })
      ).session!;
    }
    const before = await f.security.readAccountSecurity(f.id, session);
    await expect(
      f.security.changeAccountSecurity({
        accountId: f.id,
        session,
        password: activePassword,
        action: "activate_codes",
        batchId: batch.batchId,
      }),
    ).rejects.toThrow(/changed/);
    expect(
      (await f.security.readAccountSecurity(f.id, session))
        .recoveryCodesRemaining,
    ).toBe(before.recoveryCodesRemaining);
    expect(await f.p.sessionLookup(f.session)).toBeNull();
  });

test("a previous-step authenticator code is accepted with margin and refused once the window boundary has passed", async () => {
  const { totpAt, matchingTotpCounter } = await import("../../lib/totp");
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const windowStart = Math.floor(1_789_800_000_000 / 30_000) * 30_000;
  const filledAt = windowStart + 29_500;               // 500 ms before the boundary
  const code = totpAt(secret, filledAt - 30_000);      // the previous step, as the browser spec sends
  // Same window at POST time: accepted as current - 1.
  expect(matchingTotpCounter(secret, code, windowStart + 29_900, -1)).toBe(Math.floor(filledAt / 30_000) - 1);
  // Boundary crossed before the server evaluates it: now two steps old, refused.
  expect(matchingTotpCounter(secret, code, windowStart + 30_100, -1)).toBeNull();
  // The current step's code survives the boundary (it becomes current - 1).
  expect(matchingTotpCounter(secret, totpAt(secret, filledAt), windowStart + 30_100, -1)).toBe(Math.floor(filledAt / 30_000));
});

test("a new authenticator replaces the old one without passing through off, even where a workspace requires two-step sign-in", async () => {
  const f = await enrolled("replace-authenticator"),
    other = (
      await f.security.completePasswordLogin({
        accountId: f.id,
        passwordHash: f.passwordHash,
        code: f.codes[5],
        deviceLabel: "Other browser",
      })
    ).session!;
  await f.client.execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,requires_mfa,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
    args: ["ws_replace", "replace", "Required", "file::memory:", "someone-else", Date.now(), Date.now()],
  });
  await f.client.execute({
    sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,'member',0,?)",
    args: ["ws_replace", f.id, Date.now()],
  });
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: f.session, password, action: "disable", code: f.codes[0] }),
  ).rejects.toThrow(/requires two-step/);
  // Staging needs a current factor, like every other change on an enrolled account.
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: f.session, password, action: "replace_begin" }),
  ).rejects.toMatchObject({ status: 401 });
  const before = (
    await f.client.execute({ sql: "SELECT secret_enc,enabled_at,epoch FROM account_security WHERE account_id=?", args: [f.id] })
  ).rows[0];
  const staged = await f.security.changeAccountSecurity({
    accountId: f.id, session: f.session, password, action: "replace_begin", code: f.codes[1],
  });
  const fresh = staged.setup!.secret;
  expect(fresh).not.toBe(f.secret);
  const mid = (
    await f.client.execute({ sql: "SELECT secret_enc,enabled_at,pending_enc FROM account_security WHERE account_id=?", args: [f.id] })
  ).rows[0];
  // Until confirmation the old authenticator stays live and the account stays enrolled.
  expect(mid.secret_enc).toBe(before.secret_enc);
  expect(mid.enabled_at).toBe(before.enabled_at);
  expect(String(mid.pending_enc)).not.toContain(fresh);
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: other, password, action: "replace", code: totpAt(fresh, Date.now()) }),
  ).rejects.toThrow(/expired or changed/);
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: f.session, password, action: "replace", code: totpAt(f.secret, Date.now()) }),
  ).rejects.toThrow(/new authenticator/);
  // Setup and enable cannot be used to replace a live factor.
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: f.session, password, action: "enable", code: totpAt(fresh, Date.now()) }),
  ).rejects.toThrow(/expired or changed/);
  const replaced = await f.security.changeAccountSecurity({
    accountId: f.id, session: f.session, password, action: "replace", code: totpAt(fresh, Date.now()),
  });
  const after = (
    await f.client.execute({ sql: "SELECT secret_enc,enabled_at,epoch,pending_enc FROM account_security WHERE account_id=?", args: [f.id] })
  ).rows[0];
  expect(after.secret_enc).not.toBe(before.secret_enc);
  expect(after.enabled_at).toBe(before.enabled_at);
  expect(Number(after.epoch)).toBe(Number(before.epoch) + 1);
  expect(after.pending_enc).toBeNull();
  expect(await f.p.sessionLookup(f.session)).toBeNull();
  expect(await f.p.sessionLookup(other)).toBeNull();
  expect(await f.p.sessionLookup(replaced.session!)).not.toBeNull();
  const state = await f.security.readAccountSecurity(f.id, replaced.session!);
  expect(state.enabled).toBe(true);
  // Two codes spent (the other login, staging); the refused disable rolled back its code.
  expect(state.recoveryCodesRemaining).toBe(8);
  const audit = await f.client.execute({
    sql: "SELECT action FROM security_audit WHERE actor_id=? AND action='account.mfa_replaced'",
    args: [f.id],
  });
  expect(audit.rows).toHaveLength(1);
  // A minute on, the old device's code is refused and the new one's is accepted.
  const clock = Date.now, later = clock() + 60_000;
  Date.now = () => later;
  try {
    await expect(
      f.security.completePasswordLogin({ accountId: f.id, passwordHash: f.passwordHash, code: totpAt(f.secret, later), deviceLabel: "Old phone" }),
    ).rejects.toMatchObject({ status: 401 });
    const signedIn = await f.security.completePasswordLogin({
      accountId: f.id, passwordHash: f.passwordHash, code: totpAt(fresh, later), deviceLabel: "New phone",
    });
    expect(signedIn.session).toBeTruthy();
  } finally {
    Date.now = clock;
  }
});

test("the last recovery code cannot start an authenticator replacement", async () => {
  const f = await enrolled("replace-last-code");
  const last = f.codes[9];
  await f.client.execute({
    sql: "UPDATE account_recovery_codes SET used_at=? WHERE account_id=? AND code_hash!=?",
    args: [Date.now(), f.id, f.auth.tokenHash(`particl-recovery:${f.id}:${last.replace(/-/g, "")}`)],
  });
  await expect(
    f.security.changeAccountSecurity({ accountId: f.id, session: f.session, password, action: "replace_begin", code: last }),
  ).rejects.toThrow(/last code to replace/);
  expect((await f.security.readAccountSecurity(f.id, f.session)).recoveryCodesRemaining).toBe(1);
  const row = (
    await f.client.execute({ sql: "SELECT pending_enc FROM account_security WHERE account_id=?", args: [f.id] })
  ).rows[0];
  expect(row.pending_enc).toBeNull();
});
