import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * FINAL_SPEC §4 › Workflows on the Studio pages: Edit carries Dub and Change
 * voice, Deliver carries Social cuts (reframe), Gen carries an Analysis tab;
 * Astra carries nothing (draw_to_video is not advertised). Each host reads
 * the account's tool flags and either mounts the tool or says the one thing
 * in its way, inline. Nothing paid happens here.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-flows", productionProjectId: "prod-flows", shotMappings: {} });

async function open(page: Page, path: string, account: { connected: boolean; flags?: Partial<Record<"voice" | "dubbing" | "analysis" | "reframe", boolean>> }) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  /* Read once, then answer synchronously: a route that fetches while the page navigates can outlive the test. */
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: {
    connection: { connected: account.connected, requiresReconnect: false },
    capabilities: { voice: true, dubbing: true, analysis: false, reframe: true, ...account.flags, languages: [{ code: "fra", name: "French" }, { code: "jpn", name: "Japanese" }] },
    jobs: [],
  } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

test("Edit carries Dub and Change voice; Deliver carries Social cuts; Astra carries no Draw to edit", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=edit", { connected: true });
  await expect(page.getByTestId("workflow-dubbing")).toBeVisible();
  await expect(page.getByTestId("workflow-dubbing")).toContainText("Dub");
  await expect(page.getByTestId("workflow-dubbing-tool")).toBeVisible();
  await expect(page.getByTestId("workflow-voice_change-tool")).toBeVisible();
  await expect(page.getByTestId("workflow-dubbing-reason")).toHaveCount(0);

  await page.goto("/suites?suite=studio&page=deliver");
  await expect(page.getByTestId("workflow-reframe")).toContainText("Social cuts");
  await expect(page.getByTestId("workflow-reframe-tool")).toBeVisible();

  /* Astra carries no Draw to edit: the account does not advertise draw_to_video, and a card with no workflow behind it is not shown. */
  await page.goto("/suites?suite=studio&page=astra");
  await expect(page.getByTestId("stage-view")).toHaveAttribute("data-page", "astra");
  await expect(page.getByTestId("workflow-draw-to-edit")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a tool the account does not advertise, or a disconnected account, says so inline; Gen › Analysis says analysis is off", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=studio&page=deliver", { connected: true, flags: { reframe: false } });
  await expect(page.getByTestId("workflow-reframe-reason")).toHaveText("The connected account does not advertise reframe.");
  await expect(page.getByTestId("workflow-reframe-tool")).toHaveCount(0);

  await page.goto("/suites?view=gen");
  await page.getByTestId("gen-tab-analysis").click();
  await expect(page.getByTestId("workflow-video_analysis")).toContainText("Virality Predictor");
  await expect(page.getByTestId("workflow-video_analysis-reason")).toHaveText("Video analysis is switched off for this platform.");
  await page.getByRole("tab", { name: "Video" }).click();
  await expect(page.getByTestId("gen-prompt")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a disconnected account points at Workspace › Engines", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "/suites?suite=studio&page=edit", { connected: false });
  await expect(page.getByTestId("workflow-dubbing-reason")).toContainText("Connect the owner’s account in Workspace › Engines.");
  await page.getByTestId("workflow-dubbing-reason").getByRole("button", { name: "Open Engines" }).click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  expect(errors).toEqual([]);
});
