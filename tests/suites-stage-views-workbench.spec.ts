import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * Brief & Script is the Production agent's own stage (production/BriefStage).
 * Boards, Astra 3D and Deliver as the shell's own stage views:
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

const models = [
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, released: 2, efforts: [{ value: "auto", label: "Auto" }, { value: "high", label: "High" }] },
  { id: "spacexai/grok-4.7", name: "Grok 4.7", vision: true, released: 3, efforts: [{ value: "auto", label: "Auto" }] },
  { id: "openai/gpt-5.5", name: "GPT-5.5", vision: true, released: 1, efforts: [{ value: "auto", label: "Auto" }] },
];

test("Brief & Script: the agent, the prompt from the project, the Library's tools land on their sections; the floors hold", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await page.route("**/api/workbench/development**", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { configured: true, models, jobs: [] } }) : route.abort("blockedbyclient")));
  const errors = await open(page, "brief");
  await expect(page.getByTestId("brief-stage")).toBeVisible();
  const bar = page.getByTestId("agent-bar");
  for (const name of ["Claude", "Grok", "OpenAI"]) await expect(bar.getByRole("radio", { name })).toBeEnabled();
  await expect(bar.getByRole("radio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
  await expect(bar.getByRole("button", { name: "Agent model" })).toContainText("Claude Sonnet 4.6");
  await expect(page.getByTestId("brief-prompt-input")).toHaveValue("A fox crosses a frozen harbour at dusk and meets a lighthouse keeper");
  await expect(page.getByTestId("brief-estimate")).toBeEnabled();
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Brief/ })).toHaveAttribute("aria-current", "page");

  /* The Library's tools are this page's sections, not an Inspector detour. */
  if (!info.project.name.startsWith("workbench-3") && info.project.name !== "workbench-844x390") {
    const library = page.getByTestId("library");
    await expect(library.getByTestId("tool-group")).toHaveCount(2);
    await library.getByRole("button", { name: /Script editor/ }).click();
    await expect(page.getByTestId("brief-tab-script")).toHaveAttribute("aria-selected", "true");
    await library.getByRole("button", { name: /Prompt/ }).click();
    await expect(page.getByTestId("brief-tab-write")).toHaveAttribute("aria-selected", "true");
  }
  if (info.project.name.startsWith("workbench-3")) {
    expect(await smallText(page, ".pd-stage"), "text under 12px").toEqual([]);
    expect(await smallTargets(page, ".pd-stage"), "targets under 44×44").toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("Storyboards sends an empty project to Beats; Astra 3D and Deliver render their groups and keep their workflows above", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "boards");
  /* Storyboards is the Production agent's own stage: with no beat sheet yet it sends the director to Beats. */
  await expect(page.getByTestId("boards-no-shots")).toContainText("Break the script into beats and shots first.");
  await page.getByTestId("boards-no-shots").getByRole("button", { name: "Open Beats" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Beats & Shots");

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
