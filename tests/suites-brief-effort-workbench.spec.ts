import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Studio › Brief & Script › Reasoning effort: every option's label sits above
 * its description and never under it (the owner's screenshot, 23 September:
 * "Provider default" was printed over "Use this model's standard reasoning
 * settings."). Measured from the rendered boxes at one desktop and one phone.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const efforts = [
  { value: "low", label: "Low", description: "Prioritize speed with lighter reasoning." },
  { value: "medium", label: "Medium", description: "Balance reasoning depth and response time." },
  { value: "high", label: "High", description: "Spend more time on complex decisions." },
  { value: "xhigh", label: "Extra high", description: "Explore difficult decisions more thoroughly." },
];
const models = [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, efforts }];
const fixture = (): Project => ({ ...newProject("Dune Studies"), id: "ws-effort", productionProjectId: "prod-effort", shotMappings: {}, brief: "A fox crosses a frozen harbour at dusk" });

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workbench/atomik**", (route) => route.fulfill({ json: { models, jobs: [] } }));
  await page.route("**/api/workbench/development**", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { models, jobs: [] } }) : route.abort("blockedbyclient")));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=brief");
  await expect(page.getByTestId("project-name")).toHaveText("Dune Studies");
  return errors;
}

test("Reasoning effort: each option's label stands above its description, never over it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  const errors = await open(page);
  const effort = page.getByRole("combobox", { name: /effort$/ }).first();
  await effort.scrollIntoViewIfNeeded();
  await expect(effort).toBeEnabled();
  await effort.click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(efforts.length + 1);
  for (const [label, description] of [["Provider default", "Use this model’s standard reasoning settings."], ...efforts.map((e) => [e.label, e.description])]) {
    const option = options.filter({ hasText: description });
    await expect(option).toHaveAccessibleName(new RegExp(`^${label}`));
    const [a, b] = await option.evaluate((row) => {
      const text = row.firstElementChild!;
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
      return [box(text.children[0]), box(text.children[1])];
    });
    /* The label has real width, and the description begins below it. */
    expect(a.width, `${label} is visible`).toBeGreaterThan(10);
    expect(b.top, `${label} sits above its description`).toBeGreaterThanOrEqual(a.bottom - 1);
  }
  await page.screenshot({ path: info.outputPath("effort.png") });
  await options.filter({ hasText: "Spend more time" }).click();
  await expect(effort).toContainText("High");
  expect(errors).toEqual([]);
});
