import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Tenant separation for signed-out visitors (lead decisions 35 and 39), on local libSQL databases: a guest reads the
 * sample's title from the ONE workspace the platform owner named in /admin, only while Guest Home is on, and never
 * anything from another workspace. The site switches fail closed and leave the platform layer untouched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-s15-guest-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.PLATFORM_KEYS_FOR_NEW_WORKSPACES = "1";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

test.describe.configure({ mode: "serial" });

type Ws = { id: string };
let alpha: Ws, beta: Ws, gamma: Ws;

async function workspace(label: string): Promise<Ws> {
  const { createAccount, createWorkspace } = await import("../../lib/platform");
  const owner = await createAccount(`${label}@example.test`, label, "not-a-real-hash");
  return createWorkspace({ name: label, owner });
}
/** Writes a project, and optionally the sample setting, into one workspace's own database. */
async function seed(ws: Ws, project: { id: string; name: string } | null, sampleProjectId?: string) {
  const { getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const tenant = (await getWorkspace(ws.id))!;
  await runInTenant(tenant, async () => {
    await ready();
    if (project) await db().execute({ sql: `INSERT INTO projects (id, name, description, created_at) VALUES (?,?,?,?)`, args: [project.id, project.name, "", Date.now()] });
    if (sampleProjectId) await db().execute({ sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('sampleProduction', ?, 'builder', ?)`, args: [JSON.stringify({ projectId: sampleProjectId, builtBy: "someone" }), Date.now()] });
  });
}
async function site(patch: Record<string, unknown>) {
  const { writeSite } = await import("../../lib/site/settings.server");
  return writeSite(patch, "owner");
}

test.beforeAll(async () => {
  alpha = await workspace("alpha");
  beta = await workspace("beta");
  gamma = await workspace("gamma");
  await seed(alpha, { id: "proj_alpha_sample", name: "Alpha sample film" }, "proj_alpha_sample");
  await seed(alpha, { id: "proj_alpha_private", name: "Alpha private project" });
  await seed(beta, { id: "proj_beta_sample", name: "Beta sample film" }, "proj_beta_sample");
  /* Gamma names a project that exists only in Beta's database. */
  await seed(gamma, null, "proj_beta_sample");
});

test("the switches are off by default and an unreadable row stays off", async () => {
  const { readSite } = await import("../../lib/site/settings.server");
  expect(await readSite()).toEqual({ openSignup: false, guestHome: false, guestWorkspace: null });
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', '{not json', 0, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [] });
  expect(await readSite()).toEqual({ openSignup: false, guestHome: false, guestWorkspace: null });
});

test("guest Home off: nothing is read for a guest, whatever workspace is named", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: false, guestWorkspace: alpha.id });
  expect(await guestSample()).toBeNull();
  await site({ guestHome: true, guestWorkspace: null });
  expect(await guestSample()).toBeNull();
});

test("guest Home on: only the named workspace's sample title, never another workspace's", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: true, guestWorkspace: alpha.id });
  expect(await guestSample()).toEqual({ title: "Alpha sample film" });
  await site({ guestWorkspace: beta.id });
  expect(await guestSample()).toEqual({ title: "Beta sample film" });
  /* A setting pointing at another workspace's project id finds nothing: each workspace is its own database. */
  await site({ guestWorkspace: gamma.id });
  expect(await guestSample()).toBeNull();
});

test("the answer holds only the title: no ids, people, prices or settings", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  await site({ guestHome: true, guestWorkspace: alpha.id });
  const sample = await guestSample();
  expect(Object.keys(sample ?? {})).toEqual(["title"]);
  expect(JSON.stringify(sample)).not.toMatch(/proj_|someone|builder|private/);
});

test("a workspace that is deleted after it was named is no longer read", async () => {
  const { guestSample } = await import("../../lib/guest/sample.server");
  const { platformDb } = await import("../../lib/platform");
  await site({ guestHome: true, guestWorkspace: beta.id });
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = ? WHERE id = ?`, args: [Date.now(), beta.id] });
  expect(await guestSample()).toBeNull();
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = NULL WHERE id = ?`, args: [beta.id] });
});

test("only a live workspace on this deployment can be named", async () => {
  const { SiteSettingsError } = await import("../../lib/site/settings.server");
  await expect(site({ guestWorkspace: "ws_not_here" })).rejects.toBeInstanceOf(SiteSettingsError);
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: `UPDATE workspaces SET deleted_at = ? WHERE id = ?`, args: [Date.now(), gamma.id] });
  await expect(site({ guestWorkspace: gamma.id })).rejects.toBeInstanceOf(SiteSettingsError);
});

test("the guest sample is never the house workspace", async () => {
  const { SiteSettingsError } = await import("../../lib/site/settings.server");
  const { platformDb } = await import("../../lib/platform");
  const house = await workspace("house");
  await platformDb().execute({ sql: `UPDATE workspaces SET legacy = 1 WHERE id = ?`, args: [house.id] });
  try {
    await expect(site({ guestWorkspace: house.id })).rejects.toBeInstanceOf(SiteSettingsError);
  } finally {
    await platformDb().execute({ sql: `UPDATE workspaces SET legacy = 0 WHERE id = ?`, args: [house.id] });
  }
});

test("the site row never changes the platform layer (plans, caps, defaults)", async () => {
  const { platformLayerState } = await import("../../lib/platform");
  await site({ openSignup: true, guestHome: true, guestWorkspace: alpha.id });
  const layer = await platformLayerState();
  expect(layer.stored).not.toContain("site" as never);
  expect(Object.keys(layer.value)).not.toContain("site");
  await site({ openSignup: false, guestHome: false, guestWorkspace: null });
});

test("Request access keeps what they make and their brief in the request the owner reads", async () => {
  const { POST } = await import("../../app/api/access-request/route");
  const { NextRequest } = await import("next/server.js");
  const req = new NextRequest("http://localhost/api/access-request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ name: "A Person", email: "person@example.test", make: "Ad films", brief: "A short film about rain.", note: "From guest Home", company: "" }),
  });
  const res = await POST(req);
  expect(res.status).toBe(200);
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: `SELECT name, note FROM access_requests WHERE email = ?`, args: ["person@example.test"] })).rows[0] as unknown as { name: string; note: string };
  expect(row.name).toBe("A Person");
  expect(row.note).toBe("From guest Home\nWhat they make: Ad films\nTheir brief: A short film about rain.");
});
