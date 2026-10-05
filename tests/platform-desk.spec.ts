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

/* The engine cap (lib/allowanceDesk.ts) on a workspace row: read in dollars with credits at the server's credit price beside,
   set through the existing admin route, $0 included, and removed only by its own button. At the desk's desktop size and
   at the narrow layout (below 1024 px wide). */
test("the platform desk sets a workspace's monthly engine cap, $0 included, and removes it on purpose", async ({ page }, testInfo) => {
  test.skip(!["customer-1440x900", "customer-390x844"].includes(testInfo.project.name), "the desk's desktop size and its narrow layout");
  const me = await platformOwner(page);
  const name = `Cap ${randomBytes(4).toString("hex")}`;
  const created = await page.request.post("/api/workspaces", {
    headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` },
    data: { name },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const ws = (await created.json()).workspace as { id: string };
  type Desk = { creditUsd: number; defaultAllowanceUsd: number | null; workspaces: { id: string; allowanceUsd: number | null }[] };
  const desk = async () => (await page.request.get("/api/admin/invites").then((r) => r.json())) as Desk;
  const capOf = async () => (await desk()).workspaces.find((w) => w.id === ws.id)?.allowanceUsd;
  const { creditUsd, defaultAllowanceUsd } = await desk();
  expect(defaultAllowanceUsd, "this spec reads a deployment with no default cap").toBeNull();
  const crAt = (usd: number) => `${(Math.round((usd / creditUsd) * 10) / 10).toLocaleString("en-US")} CR`;
  try {
    await page.goto("/admin");
    const row = page.locator(".steam").filter({ hasText: name });
    const cap = row.getByRole("button", { name: new RegExp(`^Engine cap for ${name}`) });
    await expect(cap).toContainText("NO CAP");
    expect(await capOf()).toBeNull();
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("engine-cap-none.png"), fullPage: false });

    // Blank is refused, never read as $0.
    await cap.click();
    const box = row.getByRole("textbox", { name: `Engine cap for ${name}, dollars a month` });
    await box.fill("  ");
    await box.press("Enter");
    await expect(row.getByRole("alert")).toHaveText("Type dollars a month, 0 or more.");
    await box.fill("abc");
    await box.press("Enter");
    await expect(row.getByRole("alert")).toHaveText("Dollars a month, 0 or more, to the cent.");
    expect(await capOf()).toBeNull();

    // $0 saves as 0, and reads as a wall.
    await box.fill("0");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(cap).toContainText(`$0.00 · ${crAt(0)}`);
    await expect(cap).toContainText("Nothing can spend");
    expect(await capOf()).toBe(0);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("engine-cap-zero.png"), fullPage: false });

    // A figure, in dollars, with the credits at the server's own credit price.
    await cap.click();
    await box.fill("21.80");
    await box.press("Enter");
    await expect(cap).toContainText(`$21.80 · ${crAt(21.8)}`);
    await expect(cap).toContainText("Engine cost a month");
    expect(await capOf()).toBe(21.8);

    // Removing it is its own, confirmed act.
    await cap.click();
    await expect(box).toHaveValue("21.8");
    await row.getByRole("button", { name: "REMOVE CAP" }).click();
    await page.getByRole("button", { name: "Remove cap", exact: true }).last().click();
    await expect(cap).toContainText("NO CAP");
    expect(await capOf()).toBeNull();
    expect(await noSideScroll(page)).toBe(true);
    await cap.click();
    await expect(box).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath("engine-cap-editing.png"), fullPage: false });
  } finally {
    // Hide it again, so reruns never fill this owner's five workspaces.
    const back = await page.request.post("/api/workspaces/switch", { data: { id: ws.id } });
    expect(back.ok(), await back.text()).toBe(true);
    const removed = await page.request.delete("/api/workspaces", {
      headers: { "X-Workbench-Scope": `particl-active-${ws.id}-${me.id}` },
      data: { name },
    });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});
