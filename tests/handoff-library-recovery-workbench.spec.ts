import { expect, test, type Page } from "@playwright/test";
import { newProject } from "../lib/workbench/studio";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

const project = { ...newProject("Harbour recovery"), id: "ws-recovery", productionProjectId: "prod-ws", shotMappings: {} };
const OFFLINE = "The library is unavailable right now.";

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { estimateCredits: 1 } }));
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => route.fulfill({ json: {
    models: [{ id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p"], ratios: ["16:9"], durations: [5], use: "Video", rate: { credits: 3, resolution: "480p", ratio: "16:9", duration: 5 } }],
    audio: null, credits: 3,
  } }));
  return errors;
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

test("Gen waits for the project list to recover before creating or generating anything", async ({ page }) => {
  const errors = await setup(page);
  let mode: "failed" | "waiting" | "ready" = "failed";
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: unknown[] = [], sends: unknown[] = [];
  await page.route("**/api/workbench/projects**", async (route) => {
    if (route.request().method() !== "GET") {
      writes.push(route.request().postDataJSON());
      return route.fallback();
    }
    if (mode === "failed") return route.fulfill({ status: 503, json: { error: "Projects are unavailable right now." } });
    if (mode === "waiting") await gate;
    return route.fallback();
  });
  await page.route("**/api/generate/quote", (route) => route.fulfill({ json: { estimatedCredits: 3, fingerprint: "a".repeat(64), unit: "cr" } }));
  await page.route(/\/api\/generate$/, (route) => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: "gen_recovered", status: "succeeded" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_recovered(\?.*)?$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_recovered", projectId: project.productionProjectId }) } }));
  await page.goto("/suites?make=video");
  const banner = page.getByTestId("projects-error");
  await expect(banner).toContainText("Projects are unavailable right now.");
  await page.getByTestId("gen-prompt").fill("A lighthouse above calm water");
  const generate = page.getByTestId("gen-generate");
  // Wait for the project refusal, not the temporary block while a quote is read.
  await expect(page.getByTestId("gen-blocked")).toContainText("Try again");
  await expect(generate).toBeDisabled();
  expect(writes).toEqual([]);
  expect(sends).toEqual([]);

  mode = "waiting";
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("gen-blocked")).toHaveText("Reading the projects…");
  await expect(generate).toBeDisabled();
  expect(writes).toEqual([]);
  expect(sends).toEqual([]);
  mode = "ready";
  release();
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  await expect(banner).toHaveCount(0);
  await expect(generate).toBeEnabled();
  await expect(generate).toHaveText("Make · 3 cr");
  expect(writes).toEqual([]);
  expect(sends).toEqual([]);
  await generate.click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ projectId: project.productionProjectId, maxCredits: 3 });
  expect(writes.every((body) => (body as { project?: { id: string } }).project?.id === project.id || !(body as { project?: unknown }).project)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("an automatic Library retry keeps the same failure banner until its read succeeds", async ({ page }, info) => {
  const errors = await setup(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let reads = 0, recovering = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workbench/library**", async (route) => {
    reads++;
    if (!recovering) return route.fulfill({ status: 503, json: { error: OFFLINE } });
    await gate;
    return route.fallback();
  });
  await page.goto("/suites?make=recent");
  const banner = page.getByTestId("gen-results-error");
  await expect(banner).toContainText(OFFLINE);
  await banner.evaluate((el) => el.setAttribute("data-same-banner", "true"));
  const before = reads;
  recovering = true;
  await page.clock.fastForward(2_100);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await expect(banner).toHaveAttribute("data-same-banner", "true");
  await expect(banner).toContainText(OFFLINE);
  await expect(banner.getByRole("button", { name: "Trying…" })).toBeDisabled();
  /* Trying… is the read's status, not a spent control: undimmed, it keeps the #7C7C84 label floor. */
  expect(await banner.getByRole("button", { name: "Trying…" }).evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await expect(page.getByRole("region", { name: "Results" }).getByTestId("take-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  if (info.project.name.includes("360x640") || info.project.name.includes("390x844") || info.project.name.includes("844x390")) {
    expect(await smallTargets(page, '[data-testid="gen-results-error"]')).toEqual([]);
  }
  release();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("gen-results-empty")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
