import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";

/**
 * Found in the owner's live test, 23 September: New project in the Suites
 * left for the older workbench, and Gen's result captions ran into the next
 * card. New project now starts and opens here; a caption stays in its card.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];

test("New project starts and opens in the Suites, without leaving for the older workbench", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  await signInLocally(page.request);
  await page.goto("/suites?suite=studio&page=brief");
  await page.getByTestId("project-switcher").click();
  await page.getByTestId("project-new").click();
  const name = `Harbour ${Date.now().toString(36)}`;
  await page.getByTestId("project-new-name").fill(name);
  await page.getByTestId("project-new-create").click();
  await expect(page.getByTestId("project-switcher")).toContainText(name, { timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/suites");
  await page.getByTestId("project-switcher").click();
  await expect(page.getByRole("listbox", { name: "Projects" }).getByRole("option", { name: new RegExp(name) })).toBeVisible();
});

test("a long result caption stays inside its card in Gen", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  await signInLocally(page.request);
  await mockMedia(page);
  const store = { current: { ...newProject("Captions"), id: "ws-captions", productionProjectId: "prod-captions", shotMappings: {} } };
  await mockProjects(page, store);
  const long = "A red fox crossing a frozen harbour at dusk, a lit hut window far behind, wide shot, cinematic still, snow driving left to right";
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_a", title: long, prompt: long, projectId: "prod-captions" }), generation({ id: "gen_b", title: long, prompt: long, projectId: "prod-captions" })] });
  await page.goto("/suites?view=gen");
  const cards = page.locator(".gx-gen-grid .gx-asset");
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  for (const card of await cards.all()) {
    const box = (await card.boundingBox())!;
    for (const line of await card.locator(".gx-asset-name, .gx-asset-meta").all()) {
      const lineBox = (await line.boundingBox())!;
      expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  }
});
