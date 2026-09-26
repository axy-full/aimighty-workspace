import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";

/**
 * The legacy Rig's Run (lib/runs.ts has no runner). A recipe no longer offers
 * "Run to first checkpoint", which made a run whose stages stayed queued for
 * ever under a "Running" ring; Run opens Pipelines, where runs execute, and
 * an old run link follows it there. Real local routes, ENGINE_MOCK server,
 * every viewport.
 */
test("a recipe opens Pipelines instead of starting a run nothing advances", async ({ page }) => {
  await signInLocally(page.request);
  const created = await page.request.post("/api/projects", { data: { name: "Recipe fixture" } });
  expect(created.ok(), await created.text()).toBe(true);
  const projectId = String((await created.json()).id);
  const recipe = await page.request.post(`/api/rig/recipe/${encodeURIComponent(projectId)}`);
  expect(recipe.ok(), await recipe.text()).toBe(true);

  const runs: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/rig/runs")) runs.push(request.method()); });
  await page.goto(await legacyShell(page, `/rig/recipes/${encodeURIComponent(projectId)}`));
  await expect(page.getByRole("list", { name: "Stages" })).toBeVisible();
  await expect(page.getByText("Run to first checkpoint")).toHaveCount(0);

  const open = page.getByRole("button", { name: "Open Pipelines" }).filter({ visible: true });
  await expect(open).toHaveCount(1);
  const box = (await open.boundingBox())!;
  if ((page.viewportSize()?.width ?? 0) < 768) expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/pipelines\\?projectId=${projectId}$`));
  expect(runs).toEqual([]);

  // A bookmarked run, or the Run tab's old address, lands on the same place.
  await page.goto(`/rig/run/latest?project=${encodeURIComponent(projectId)}`);
  await expect(page).toHaveURL(new RegExp(`/pipelines\\?projectId=${projectId}$`));
  await page.goto("/rig/run/run_old");
  await expect(page).toHaveURL(/\/pipelines$/);
});
