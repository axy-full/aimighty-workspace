import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP, forbidPaid, projectWithShots } from "./helpers/appPagesAudit";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: a project's legacy pages point at its own views. Nothing here
 * submits paid work. The audit is spread over files whose names sort apart,
 * because CI shards take contiguous runs of files and each legacy page costs
 * its dev server gigabytes to compile.
 */

test("a project's legacy pages point at this project's own views, and an unknown project says so", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links and states, once.");
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  const base = `/productions/${project.productionId}/${project.id}`;

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("link", { name: "Render in Shots" })).toHaveAttribute("href", `${base}/shots`);
  await expect(page.locator("a.chip").filter({ hasText: /^Takes$/ })).toHaveAttribute("href", `${base}/media`);
  await expect(page.getByRole("link", { name: "Open in Generate" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Project dashboard" })).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Project" });
  await expect(nav.getByRole("link", { name: "Elements" })).toHaveAttribute("href", `/projects/${project.id}/rig/elements`);
  await expect(nav.getByRole("link", { name: "Setup" })).toHaveAttribute("href", "/studio/shot");

  await page.goto(`/projects/${project.id}/canvas`);
  await expect(page.getByRole("link", { name: "Open takes" })).toHaveAttribute("href", `${base}/media`);
  await expect(page.getByRole("link", { name: "Render in Shots" })).toHaveAttribute("href", `${base}/shots`);

  await page.goto(`${base}/media`);
  const tabs = page.getByRole("group", { name: "Project" }).first();
  await expect(tabs.getByRole("button")).toHaveText(["Shots", "Media"]);
  await expect(page.getByText("By shot ▾")).toHaveCount(0);

  await page.goto("/projects/proj_does_not_exist");
  await expect(page.getByText("No such project.")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Projects" })).toBeVisible();

  /* A list served stale by another instance's memo, without a project made a moment ago, does not declare it gone. */
  await page.route("**/api/projects", (route) => route.request().method() === "GET" ? route.fulfill({ json: { unit: "cr", projects: [] } }) : route.fallback());
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "Audit film" })).toBeVisible();
  await expect(page.getByText("No such project.")).toHaveCount(0);
});
