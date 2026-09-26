import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { localPlatformDbUrl } from "./workbenchLocal";

/** Shared by tests/account-identity.spec.ts and tests/platform-desk.spec.ts. */
export const password = "a local browser test passphrase 42";
export const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** A sign-up invitation for `email`, written straight to the local platform database. */
export async function signupInvite(email: string) {
  const code = randomBytes(18).toString("base64url");
  const db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
  try {
    await db.execute({
      sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      args: [code, email, "Tester", "Local browser test", "test", Date.now(), Date.now() + 3_600_000],
    });
  } finally {
    db.close();
  }
  return code;
}
