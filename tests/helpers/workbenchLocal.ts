import { test, expect, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";

export function localPlatformDbUrl() {
  const url = process.env.PW_PLATFORM_DATABASE_URL || "file:.data/ark.db";
  if (!url.startsWith("file:"))
    throw new Error(
      "Browser fixtures require an explicitly local platform database.",
    );
  return url;
}

/** Create an isolated local account through the real invitation and signup routes. */
export async function signInLocally(api: APIRequestContext) {
  const base = process.env.PW_BASE_URL || "http://localhost:4551";
  test.skip(
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base),
    "requires an explicitly local server",
  );
  const health = await api
    // A reused keep-alive socket can close between local browser fixtures.
    // Retry only transport resets on this read-only readiness request.
    .get("/api/health", { timeout: 15_000, maxRetries: 2 })
    .then((response) => response.json());
  test.skip(!health.mock, "requires a local ENGINE_MOCK=1 server");
  const code = randomBytes(18).toString("base64url");
  const email = `workbench-${code}@example.test`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
  try {
    await db.execute({
      sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      args: [
        code,
        email,
        "Workbench Tester",
        "Local browser test",
        "test",
        Date.now(),
        Date.now() + 3_600_000,
      ],
    });
  } finally {
    db.close();
  }
  const signup = await api.post("/api/auth/signup", {
    data: {
      code,
      name: "Workbench Tester",
      email,
      workspace: `Browser ${code}`,
      password: "a local browser test passphrase 42",
      accept: true,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  return (await signup.json()) as {
    workspace: { id: string; name: string; slug: string };
  };
}

/**
 * A member of someone else's workspace, through the real invitation route:
 * `owner` signs up (and so owns a fresh workspace), a member invitation to it
 * is filed in the local platform database, and `member` accepts it — so
 * `member` (a page's request context, say) holds a member's session there.
 * `ownerName` renames the owner's account, so a page can be checked for
 * naming this workspace's owner and no other.
 */
export async function joinLocallyAsMember(owner: APIRequestContext, member: APIRequestContext, options: { ownerName?: string } = {}) {
  const { workspace } = await signInLocally(owner);
  const code = randomBytes(18).toString("base64url");
  const email = `member-${code}@example.test`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, workspace.id, email, "Workbench Member", "member", null, Date.now(), Date.now() + 3_600_000],
    });
    if (options.ownerName) await db.execute({
      sql: "UPDATE accounts SET name = ? WHERE id = (SELECT account_id FROM memberships WHERE workspace_id = ? AND role = 'owner')",
      args: [options.ownerName, workspace.id],
    });
  } finally {
    db.close();
  }
  const accepted = await member.post("/api/auth/accept", {
    data: { code, name: "Workbench Member", password: "a local browser test passphrase 42" },
  });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  return { workspace, email };
}
