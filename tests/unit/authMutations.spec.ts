import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-auth-mutations-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

test("cross-origin simple form POST cannot set, destroy or bootstrap an account session", async () => {
  const handlers = [
    (await import("../../app/api/auth/login/route")).POST,
    (await import("../../app/api/auth/logout/route")).POST,
    (await import("../../app/api/auth/setup/route")).POST,
    (await import("../../app/api/auth/reset/route")).POST,
    (await import("../../app/api/auth/reset/[token]/route")).POST,
  ];
  for (const handler of handlers) {
    const request = new Request("https://particl.test/api/auth/action", {
      method: "POST",
      headers: {
        Origin: "https://attacker.test",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({
        email: "attacker@example.test",
        password: "attacker-pass-2026",
      }),
    });
    const response = await handler(request, {
      params: Promise.resolve({ token: "fixture" }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  const { sameOriginProblem } = await import("../../lib/accountDb");
  expect(
    sameOriginProblem(
      new Request("https://particl.test/api/auth/login", {
        headers: { Origin: "https://particl.test" },
      }),
    ),
  ).toBe(false);
  expect(
    sameOriginProblem(new Request("https://particl.test/api/auth/login")),
  ).toBe(false); // Non-browser API compatibility.
});

async function fixture(account: string) {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { tokenHash, hashPassword } = await import("../../lib/auth");
  await platformReady();
  const p = platformDb(),
    at = Date.now();
  await p.execute({
    sql: "INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
    args: [
      account,
      account + "@example.test",
      account,
      hashPassword("old-password-2026"),
      at,
    ],
  });
  for (const token of [account + "-first", account + "-second"])
    await p.execute({
      sql: "INSERT INTO password_resets(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
      args: [tokenHash(token), account, at, at + 3600_000],
    });
  await p.execute({
    sql: "INSERT INTO p_sessions(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)",
    args: [tokenHash(account + "-old-session"), account, at, at + 3600_000],
  });
  return { p, tokenHash };
}

test("a late reset transaction failure preserves old password, reset tokens and existing sessions", async () => {
  const { p, tokenHash } = await fixture("rollback");
  const { resetAccountPassword } = await import("../../lib/passwordReset");
  const { verifyPassword } = await import("../../lib/auth");
  await p.execute(
    "CREATE TRIGGER reject_new_session BEFORE INSERT ON p_sessions BEGIN SELECT RAISE(ABORT,'fixture session persistence failure'); END",
  );
  await expect(
    resetAccountPassword("rollback-first", "new-password-2026"),
  ).rejects.toThrow(/fixture session persistence failure/);
  expect(
    verifyPassword(
      "old-password-2026",
      String(
        (
          await p.execute(
            "SELECT password_hash FROM accounts WHERE id='rollback'",
          )
        ).rows[0].password_hash,
      ),
    ),
  ).toBe(true);
  expect(
    Number(
      (
        await p.execute(
          "SELECT COUNT(*) n FROM password_resets WHERE user_id='rollback' AND used_at IS NULL",
        )
      ).rows[0].n,
    ),
  ).toBe(2);
  expect(
    (
      await p.execute({
        sql: "SELECT token_hash FROM p_sessions WHERE account_id='rollback'",
        args: [],
      })
    ).rows.map((row) => row.token_hash),
  ).toEqual([tokenHash("rollback-old-session")]);
  await p.execute("DROP TRIGGER reject_new_session");
  expect(
    (await resetAccountPassword("rollback-first", "new-password-2026")).session,
  ).toBeTruthy();
});

test("concurrent reset attempts consume a link once, revoke all prior sessions and invalidate sibling links", async () => {
  const { p, tokenHash } = await fixture("concurrent");
  const { resetAccountPassword } = await import("../../lib/passwordReset");
  const outcomes = await Promise.allSettled([
    resetAccountPassword("concurrent-first", "new-password-2026"),
    resetAccountPassword("concurrent-first", "different-password-2026"),
  ]);
  const successes = outcomes.filter((result) => result.status === "fulfilled");
  expect(successes).toHaveLength(1);
  expect(
    Number(
      (
        await p.execute(
          "SELECT COUNT(*) n FROM password_resets WHERE user_id='concurrent' AND used_at IS NULL",
        )
      ).rows[0].n,
    ),
  ).toBe(0);
  const rows = (
    await p.execute(
      "SELECT token_hash FROM p_sessions WHERE account_id='concurrent'",
    )
  ).rows;
  expect(rows).toHaveLength(1);
  if (successes[0].status === "fulfilled")
    expect(rows[0].token_hash).toBe(tokenHash(successes[0].value.session!));
  await expect(
    resetAccountPassword("concurrent-second", "other-password-2026"),
  ).rejects.toThrow(/already used/);
});
