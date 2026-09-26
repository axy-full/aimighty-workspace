import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { password, noSideScroll, signupInvite } from "./helpers/identityAdmin";

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
  await expect(page.getByText(/credits from an approved invitation, 0 from self-serve sign-up/)).toBeVisible();
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
