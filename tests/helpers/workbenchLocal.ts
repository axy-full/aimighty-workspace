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
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
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
