import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { password, noSideScroll, signupInvite } from "./helpers/identityAdmin";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";

/* The platform owner's desk (/admin), at one desktop size. It has its own spec
   so that a CI shard compiling it is not also compiling every account page:
   together they took one shard's dev server past the runner's memory. Local
   ENGINE_MOCK server only; the server must run with SUPER_ADMIN_EMAIL set to
   the fixture address below (CI does). */

/** Signed in as the platform owner, the one account the deployment names. */
async function platformOwner(page: Page): Promise<{ id: string; workspace: { id: string } }> {
  const ownerEmail = "platform-owner@example.test";
  const login = await page.request.post("/api/auth/login", { data: { email: ownerEmail, password } });
  if (!login.ok()) {
    const code = await signupInvite(ownerEmail);
    const signup = await page.request.post("/api/auth/signup", {
      data: { code, name: "Platform owner", email: ownerEmail, workspace: "Platform desk", password, accept: true },
    });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await page.request.get("/api/me").then((r) => r.json());
  // Only the deployment names the platform owner; the server under test must
  // run with SUPER_ADMIN_EMAIL set to this fixture address (CI does).
  expect(me.superAdmin, `start the server with SUPER_ADMIN_EMAIL=${ownerEmail}`).toBe(true);
  return me;
}

test("the platform desk marks a deleted workspace and restores it; money stays off it until then", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "customer-1440x900", "the platform desk is a desktop console: one desktop size");
  const me = await platformOwner(page);
  const name = `Closing ${randomBytes(4).toString("hex")}`;
  const created = await page.request.post("/api/workspaces", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    data: { name },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const ws = (await created.json()).workspace;
  const removed = await page.request.delete("/api/workspaces", {
    headers: { "X-Workbench-Scope": `particl-active-${ws.id}-${me.id}` },
    data: { name },
  });
  expect(removed.ok(), await removed.text()).toBe(true);
  const refused = await page.request.patch(`/api/admin/workspaces/${ws.id}`, { data: { grantCredits: 100 } });
  expect(refused.status()).toBe(409);
  // Marking is not money: a deleted workspace can be flagged for the desk.
  const marked = await page.request.patch(`/api/admin/workspaces/${ws.id}`, { data: { flagged: true, note: "Review before restoring" } });
  expect(marked.ok(), await marked.text()).toBe(true);
  await page.goto("/admin");
  const row = page.locator(".steam").filter({ hasText: name });
  await expect(row.getByText("DELETED", { exact: true })).toBeVisible();
  await expect(row.getByText(/· FLAGGED/)).toBeVisible();
  await row.getByRole("button", { name: "Clear flag" }).click();
  await expect(row.getByText(/· FLAGGED/)).toHaveCount(0);
  await expect(page.getByText(/Approved invitations start with \d+ credits; self-serve sign-ups start with 0/)).toBeVisible();
  await expect(page.getByText(/VERCEL_TOKEN/)).toHaveCount(0);
  expect(await noSideScroll(page)).toBe(true);
  await row.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).last().click();
  await expect(row.getByText("DELETED", { exact: true })).toHaveCount(0);
  await expect(row.getByText("ACTIVE", { exact: true })).toBeVisible();
  const list = await page.request.get("/api/workspaces").then((r) => r.json());
  expect(list.workspaces.map((w: { id: string }) => w.id)).toContain(ws.id);
  // Hide it again, so reruns never fill this owner's five workspaces.
  const back = await page.request.post("/api/workspaces/switch", { data: { id: ws.id } });
  expect(back.ok(), await back.text()).toBe(true);
  const again = await page.request.delete("/api/workspaces", {
    headers: { "X-Workbench-Scope": `particl-active-${ws.id}-${me.id}` },
    data: { name },
  });
  expect(again.ok(), await again.text()).toBe(true);
});

test("the platform desk reads the house workspace as never billed: no balance, nothing added, its spend at cost", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "customer-1440x900", "the platform desk is a desktop console: one desktop size");
  const me = await platformOwner(page);
  /* A deployment has its house workspace once its primary database has people (lib/platform.ts importLegacy): the row
     is seeded as that import writes it, with one job its engines ran, metered at cost and billed nothing. */
  const at = Date.now();
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: `INSERT OR IGNORE INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
            VALUES ('ws_legacy', 'house-desk', 'House', '(primary)', NULL, 1, 1, ?, ?, ?)`,
      args: [me.id, at, at],
    });
    await platform.execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at)
            VALUES(?,'ws_legacy','image','google','gemini-3.1-flash-image','succeeded',0.04,0,0,?,?)`,
      args: [`house_desk_${randomBytes(4).toString("hex")}`, at, at],
    });
  } finally { platform.close(); }
  /* It takes no credits and no allowance: refused before anything is written. */
  for (const data of [{ grantCredits: 100 }, { allowanceUsd: 10 }]) {
    const refused = await page.request.patch("/api/admin/workspaces/ws_legacy", { data });
    expect(refused.status(), JSON.stringify(data)).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/never billed in credits/);
  }
  const desk = await page.request.get("/api/admin/invites").then((r) => r.json()) as { workspaces: { id: string }[] };
  expect(desk.workspaces.find((w) => w.id === "ws_legacy")).toMatchObject({
    house: true, credits: null, spend30: { atCost: true, billedCredits: 0, marginUsd: null },
  });
  await page.goto("/admin");
  const row = page.locator(".steam").filter({ hasText: "HOUSE · NOT BILLED" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(/ at cost$/)).toBeVisible();
  await expect(row).not.toContainText(/ CR\b|margin/);
  expect(await noSideScroll(page)).toBe(true);
});

/* The credit-unit conversion (lib/creditConversion.ts) is the platform owner's alone, and a dry run by default. */
test("the credit-unit route: anonymous 401, a member 403, the owner's dry run writes nothing", async ({ page, playwright }, testInfo) => {
  test.skip(testInfo.project.name !== "customer-1440x900", "an API check: one size");
  const base = process.env.PW_BASE_URL || "http://localhost:4551";
  const anonymous = await playwright.request.newContext({ baseURL: base });
  expect((await anonymous.get("/api/admin/credit-unit")).status()).toBe(401);
  expect((await anonymous.post("/api/admin/credit-unit", { data: { action: "convert", fromUnitUsd: 0.8, cutoverAt: "2026-10-03T14:39:00Z" } })).status()).toBe(401);
  const member = await playwright.request.newContext({ baseURL: base });
  const email = `member-${randomBytes(4).toString("hex")}@example.test`;
  const code = await signupInvite(email);
  const signup = await member.post("/api/auth/signup", { data: { code, name: "Member", email, workspace: "Member studio", password, accept: true } });
  expect(signup.ok(), await signup.text()).toBe(true);
  expect((await member.get("/api/admin/credit-unit")).status()).toBe(403);
  expect((await member.post("/api/admin/credit-unit", { data: { action: "convert", fromUnitUsd: 0.8, cutoverAt: "2026-10-03T14:39:00Z", dryRun: false } })).status()).toBe(403);
  await platformOwner(page);
  const state = await page.request.get("/api/admin/credit-unit").then((r) => r.json());
  expect(state.creditUsd).toBe(0.1);
  // No zone on cutoverAt is refused rather than read in the server's.
  expect((await page.request.post("/api/admin/credit-unit", { data: { action: "convert", fromUnitUsd: 0.8, cutoverAt: "2026-10-03T14:39:00" } })).status()).toBe(400);
  const dry = await page.request.post("/api/admin/credit-unit", { data: { action: "convert", fromUnitUsd: 0.8, cutoverAt: "2026-10-03T14:39:00Z" } });
  expect(dry.ok(), await dry.text()).toBe(true);
  const body = await dry.json();
  expect(body).toMatchObject({ dryRun: true, fromUnitUsd: 0.8, toUnitUsd: 0.1, factor: 8 });
  const after = await page.request.get("/api/admin/credit-unit").then((r) => r.json());
  expect(after.conversions.length).toBe(state.conversions.length);
  // A real run on a deployment whose ledger already counts in $0.10 converts nothing.
  const real = await page.request.post("/api/admin/credit-unit", { data: { action: "convert", fromUnitUsd: 0.8, cutoverAt: "2026-10-03T14:39:00Z", dryRun: false } });
  if (real.ok()) expect((await real.json()).results).toEqual([]);
  await anonymous.dispose(); await member.dispose();
});
