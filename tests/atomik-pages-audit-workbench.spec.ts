import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP, forbidPaid, projectWithShots } from "./helpers/appPagesAudit";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: Atomik's shot list and breakdown price a credit workspace in
 * credits. Nothing here submits paid work. The audit is spread over files
 * whose names sort apart, because CI shards take contiguous runs of files and
 * each legacy page costs its dev server gigabytes to compile.
 */

test("Atomik shot list and breakdown price a credit workspace in credits, never dollars", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "One pass for the money; the layout pass is below.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), project.id);
  /* Takes with a vendor cost are exercised in tests/unit/appPagesAuditDb.spec.ts; here the lists carry no dollar figure field at all for this workspace. */
  const listed = (await (await page.request.get("/api/projects")).json()) as { unit: string; projects: { id: string; spend: number }[] };
  expect(listed.unit).toBe("cr");
  expect(listed.projects.every((p) => p.spend === 0)).toBe(true);

  await page.goto("/atomik/shots");
  await expect(page.getByRole("heading", { name: "Shot list" })).toBeVisible();
  const list = page.locator(".ak-page");
  await expect(list.locator(".ak-table-foot")).toContainText(/EST\. \d+ CR · SPENT 0 CR/);
  await expect(list).not.toContainText("$");

  await page.goto("/atomik/breakdown");
  const bar = page.locator(".ak-bar");
  await expect(bar).toContainText(/EST\. \d+ CR AT ONE TAKE EACH/);
  await expect(bar).not.toContainText("$");
});
