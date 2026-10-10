import { expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { SITE_ROW } from "../../lib/site/settings";
import { localPlatformDbUrl } from "./workbenchLocal";
import { seedMarkedSample } from "./guestSample";

/**
 * Fixtures for the visitor's new interface (redesign P4): the site switches written in the local platform database (as
 * tests/demo-s15-guest-home-workbench.spec.ts does), a sample production in a workspace of its own, and invitations in
 * every state. Local ENGINE_MOCK servers only; nothing is generated and nothing is sent.
 */
export async function setSite(value: { openSignup?: boolean; guestHome?: boolean; visitorPages?: boolean; guestWorkspace?: string | null }) {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [SITE_ROW, JSON.stringify({ openSignup: false, guestHome: false, visitorPages: false, guestWorkspace: null, ...value }), Date.now(), "test"],
    });
  } finally { db.close(); }
}

/** Guest Home on, with a marked sample production in a workspace of its own (a separate browser context, so the visitor stays signed out). */
export async function visitorSite(browser: Browser, options: { sample?: boolean } = {}) {
  let guestWorkspace: string | null = null;
  let title: string | null = null;
  if (options.sample !== false) {
    const context = await browser.newContext();
    try {
      const seeded = await seedMarkedSample(await context.newPage(), { approve: 2, name: "A short walk film" });
      guestWorkspace = seeded.workspaceId;
      title = seeded.project.name;
    } finally { await context.close(); }
  }
  await setSite({ guestHome: true, visitorPages: true, guestWorkspace });
  return { title, guestWorkspace };
}

type Row = { code: string; email: string };
const stamp = () => randomBytes(12).toString("base64url");

/** A new-workspace invitation (`signup_invites`), fresh or used. */
export async function signupInvite(state: "fresh" | "used" = "fresh"): Promise<Row> {
  const code = stamp(), email = `visitor-${code}@example.test`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, email, "Invited Person", "Visitor test", "test", Date.now(), Date.now() + 3_600_000, state === "used" ? Date.now() : null],
    });
  } finally { db.close(); }
  return { code, email };
}

/** A team invitation (`workspace_invites`) to `workspaceId`, fresh or already used. */
export async function teamInvite(workspaceId: string, state: "fresh" | "used" = "fresh"): Promise<Row> {
  const code = stamp(), email = `member-${code}@example.test`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,?,?,?)",
      args: [code, workspaceId, email, "Invited Member", "member", "test", Date.now(), Date.now() + 3_600_000, state === "used" ? Date.now() : null],
    });
  } finally { db.close(); }
  return { code, email };
}

/** Every API request a page makes, so a spec can show a visitor reached nothing it should not. */
export function apiLog(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) seen.push(`${req.method()} ${url.pathname}${url.search}`);
  });
  return seen;
}

export async function noOverflow(page: Page, where = "page") {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${where}: no horizontal overflow`).toBe(true);
}
