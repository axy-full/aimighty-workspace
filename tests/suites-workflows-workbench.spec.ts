import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * The connected account's workflows on the Studio pages — Edit's Dub and
 * Change voice, Deliver's Social cuts, Gen's Analysis (the Virality
 * Predictor) — went with the Higgsfield sign-in
 * (lib/higgsfield-consumer/retired.ts), for the workspace owner too. No card
 * stands in for them. Edit & Sound keeps Particl's own Dub and Change voice
 * (ElevenLabs), so the page is no dead end. Nothing here spends, and nothing
 * asks the account for anything.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-flows", productionProjectId: "prod-flows", shotMappings: {} });
/** The shell's collector lists the owner's saved jobs (a ledger read, never the account): the one account route still called. */
const COLLECTOR_LIST = "GET /api/higgsfield/consumer/generation";

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route(/\/api\/audio$/, (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: true, speechModels: [{ id: "speech-a", label: "Speech" }], defaultSpeechModel: "speech-a", voices: [{ id: "voice_a", name: "Avery", category: "premade" }], voicesError: null } })
    : route.fallback());
  await page.route("**/api/audio/voices**", (route) => route.fulfill({ json: { configured: true, voices: [{ id: "voice_a", name: "Avery", category: "premade" }] } }));
  const consumer: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/higgsfield/consumer/")) consumer.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, consumer };
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}


test("Gen has no Analysis tab, for the owner too: its three output tabs keep one row", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, consumer } = await open(page, "/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  const output = page.getByRole("tablist", { name: "Output" });
  await expect(output.getByRole("tab")).toHaveText(["Video", "Images", "Audio"]);
  await expect(page.getByTestId("gen-tab-analysis")).toHaveCount(0);
  await expect(page.getByTestId("workflow-video_analysis")).toHaveCount(0);
  const tabs = await output.getByRole("tab").all();
  const tops = await Promise.all(tabs.map(async (tab) => (await tab.boundingBox())!.y));
  expect(new Set(tops.map((y) => Math.round(y))).size, "one row of tabs").toBe(1);
  if (PHONES.includes(info.project.name)) for (const tab of tabs) expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await noSideScroll(page);
  expect(consumer.filter((request) => request !== COLLECTOR_LIST)).toEqual([]);
  expect(errors).toEqual([]);
});
