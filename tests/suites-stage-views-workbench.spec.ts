import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * Brief & Script, Boards, Astra 3D and Deliver as the shell's own stage views:
 * the intro, the five facts, the groups as framed cards in the department
 * colours with a status dot each, and the stage's existing working tool
 * beneath. A card that belongs to a tool opens it; the Deliver and Astra
 * workflows sit above. Every count is the project's own.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({
  ...newProject("Coastal light study"), id: "ws-stages", productionProjectId: "prod-stages", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk and meets a lighthouse keeper",
});

async function open(page: Page, stage: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: { connection: { connected: false, requiresReconnect: false }, capabilities: { voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }, jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=studio&page=${stage}`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

test("Brief & Script: facts and groups from the project; a card opens its tool; the floors hold", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "brief");
  const view = page.getByTestId("stage-view");
  await expect(view).toHaveAttribute("data-page", "brief");
  await expect(page.getByTestId("stage-facts")).toContainText("13 words");
  await expect(page.getByTestId("stage-facts")).toContainText("Screenplay");
  await expect(page.getByTestId("stage-group")).toHaveCount(2);
  await expect(page.getByTestId("stage-group").nth(0)).toContainText("DOCUMENT");
  await expect(page.getByTestId("stage-group").nth(1)).toContainText("AGENTIC");
  await expect(view.locator(".gx-stage-card")).toHaveCount(7);
  await expect(view.locator(".gx-stage-card[data-card='Brief']")).toContainText("13 words");
  await expect(page.getByTestId("stage-work")).toHaveAttribute("data-tool", "brief");
  await view.locator("button.gx-stage-card[data-card='Script']").click();
  await expect(page.getByTestId("stage-work")).toHaveAttribute("data-tool", "script");
  await expect(page.getByTestId("stage-work").getByRole("tab", { name: "Script & development" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Brief/ })).toHaveAttribute("aria-current", "page");
  if (info.project.name.startsWith("workbench-3")) {
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
    expect(await smallTargets(page, ".gx-stage-view"), "targets under 44×44").toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("Boards, Astra 3D and Deliver render their groups and keep their workflows above", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "boards");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-page", "boards");
  await expect(page.getByTestId("stage-group")).toHaveCount(2);
  await expect(page.getByTestId("stage-facts")).toContainText("Nano Banana 2");

  await page.goto("/suites?suite=studio&page=astra");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-page", "astra");
  /* FINISHING's two upscale cards had no tool and no plan behind them, so the group is gone (owner's rule). */
  await expect(page.getByTestId("stage-group")).toHaveCount(1);
  await expect(page.getByTestId("stage-view").locator(".gx-stage-card[data-card='Video upscale']")).toHaveCount(0);
  await expect(page.getByTestId("page-workflows")).toHaveCount(0);

  await page.goto("/suites?suite=studio&page=deliver");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-page", "deliver");
  await expect(page.getByTestId("stage-group")).toHaveCount(2);
  await expect(page.getByTestId("stage-facts")).toContainText("No shots yet");
  await expect(page.getByTestId("workflow-reframe")).toBeVisible();
  /* The Social cuts card was a description of the reframe workflow above it; the workflow stays, the card goes. */
  await expect(page.getByTestId("stage-view").locator(".gx-stage-card[data-card='Social cuts']")).toHaveCount(0);
  await expect(page.getByTestId("stage-work")).toHaveAttribute("data-tool", "package");
  expect(errors).toEqual([]);
});
