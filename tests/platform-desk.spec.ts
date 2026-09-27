import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { password, noSideScroll, signupInvite } from "./helpers/identityAdmin";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { smallTargets } from "./phoneFloors";

/* The platform owner's desk (/admin), at one desktop size. It has its own spec
   so that a CI shard compiling it is not also compiling every account page:
   together they took one shard's dev server past the runner's memory. Local
   ENGINE_MOCK server only; the server must run with SUPER_ADMIN_EMAIL set to
   the fixture address below (CI does). */

test("the platform desk marks a deleted workspace and restores it; money stays off it until then", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "customer-1440x900", "the platform desk is a desktop console: one desktop size");
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

/* Platform desk › Website tools account, at every size: the platform owner
   designates their own connected account (seeded as connected in the local
   platform database; no account is read), switches tools on and off, pauses
   and releases it. While designated, the connection cannot be disconnected
   here. Nothing is quoted or sent. */
test("the website tools account is designated, paused and released from the desk, at every size", async ({ page }, testInfo) => {
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
  expect(me.superAdmin, `start the server with SUPER_ADMIN_EMAIL=${ownerEmail}`).toBe(true);
  const scope = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  // A rerun starts from no designation.
  const first = await page.request.get("/api/admin/website-account").then((r) => r.json());
  if (first.state !== "unset") expect((await page.request.post("/api/admin/website-account", { headers: scope, data: { action: "release" } })).ok()).toBe(true);
  // The owner's own connection, connected to a known account (ledger only; no token).
  const db = createClient({ url: localPlatformDbUrl(), timeout: 5_000 });
  try {
    await db.execute({
      sql: `INSERT INTO higgsfield_consumer_connections(workspace_id,user_id,authorization_id,generation,status,updated_at,subject_hash)
        VALUES(?,?,?,?,'connected',?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='connected',subject_hash=excluded.subject_hash,updated_at=excluded.updated_at`,
      args: [me.workspace.id, me.id, randomBytes(8).toString("hex"), randomBytes(8).toString("hex"), Date.now(), "a".repeat(64)],
    });
  } finally { db.close(); }

  await page.goto("/admin");
  const card = page.getByTestId("website-account");
  await expect(card.getByTestId("website-account-state")).toHaveText("Not designated");
  await expect(card.getByTestId("website-account-rate")).toHaveText(/Credit rate (not )?set/);
  const phone = (page.viewportSize()?.width ?? 1440) < 900;
  const fits = async (where: string) => {
    await card.scrollIntoViewIfNeeded();
    const box = await card.evaluate((el) => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth - el.clientWidth }));
    expect(box.right, `${where}: the card ends inside the screen`).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
    expect(box.scroll, `${where}: nothing inside the card scrolls sideways`).toBeLessThanOrEqual(1);
    if (phone) expect(await smallTargets(page, '[data-testid="website-account"]'), `${where}: targets under 44×44`).toEqual([]);
    const tiny = await card.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.getClientRects().length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()) && Number.parseFloat(getComputedStyle(el).fontSize) < 12)
      .map((el) => `${getComputedStyle(el).fontSize}: ${(el.textContent ?? "").trim().slice(0, 30)}`));
    expect(tiny, `${where}: text under 12px`).toEqual([]);
  };
  await fits("before designation");

  await card.getByTestId("website-account-designate").click();
  await expect(card.getByTestId("website-account-state")).toHaveText("Ready");
  await expect(card.getByText(/this workspace/)).toBeVisible();
  const locked = await page.request.delete("/api/higgsfield/consumer/connection", { headers: scope });
  expect(locked.status()).toBe(409);
  expect((await locked.json()).code).toBe("platform_account_locked");
  await card.getByTestId("website-tool-shorts").click();
  await expect(card.getByTestId("website-tool-shorts")).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByTestId("website-tool-shorts")).toContainText("On");
  // A tool with no private price cannot be switched on.
  await expect(card.getByTestId("website-tool-voice-change")).toBeDisabled();
  await expect(card.getByTestId("website-tool-voice-change")).toContainText("Needs a price");
  await fits("designated");
  await card.getByTestId("website-account-pause").click();
  await expect(card.getByTestId("website-account-state")).toHaveText("Paused");
  await card.getByTestId("website-account-pause").click();
  await expect(card.getByTestId("website-account-state")).toHaveText("Ready");
  const view = JSON.stringify(await page.request.get("/api/admin/website-account").then((r) => r.json()));
  expect(view).not.toContain("a".repeat(64));
  expect(view).not.toContain(me.id);

  await card.getByTestId("website-account-release").click();
  await page.getByRole("button", { name: "Release", exact: true }).last().click();
  await expect(card.getByTestId("website-account-state")).toHaveText("Not designated");
  await fits("released");
  testInfo.annotations.push({ type: "size", description: `${page.viewportSize()?.width}x${page.viewportSize()?.height}` });
});
