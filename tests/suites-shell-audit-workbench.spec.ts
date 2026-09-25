import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * The Suites shell, audited (September 2026): a Retry pressed on Gen lands at
 * once with its references and never replays later; the phone's Assets tab
 * works from More; "Run stage" opens the page's Atomik plan with its reason or
 * its gate; the Library's Tools lead somewhere or are not offered; the phone
 * Studio grid counts the project as saved now; an audio take opens its
 * transcript on Takes.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-audit", productionProjectId: "prod-ws", shotMappings: {}, brief: "A fox crosses the ice" });

async function open(page: Page, path: string, store = { current: fixture() }) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, store);
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" }), upload({ id: "up_tone", filename: "room-tone.mp3", mime: "audio/mpeg", kind: "audio", width: 0, height: 0 })],
    generations: [
      generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water", params: { rawPrompt: "wide on the water, raw", references: [{ uploadId: "up_plate", role: "reference_image", kind: "image" }] } }),
      generation({ id: "gen_voice", title: "Harbour voice", prompt: "the keeper speaks", kind: "audio", model: "eleven_v3" }),
    ],
  });
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } }));
  await page.route(/\/api\/uploads\/up_plate\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_plate", filename: "harbour-plate.webp" }) } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

test("Retry pressed on Gen lands at once, with the take's own references, and nothing replays when Gen opens again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']").click();
  await page.getByTestId("asset-inspector").getByRole("button", { name: "Retry generation" }).click();
  await expect(page.getByTestId("toast")).toContainText("Retry Wide on the water");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("wide on the water, raw");
  await expect(page.getByTestId("gen-preset-note")).toContainText("Retry · Wide on the water · same inputs · new seed");
  await expect(page.getByTestId("gen-well")).toContainText("harbour-plate.webp");

  /* Leave and come back: the composer starts as it should, not with the old retry laid over it. */
  await page.getByTestId("gen-prompt").fill("my own words");
  const suites = page.getByRole("tablist", { name: "Suites" });
  await suites.getByRole("tab", { name: "Studio" }).click();
  await expect(page.getByTestId("gen-view")).toHaveCount(0);
  await suites.getByRole("tab", { name: "Gen" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).not.toHaveValue("wide on the water, raw");
  await expect(page.getByTestId("gen-preset-note")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("phone: Assets from More (Workspace) opens the Library over the suite page", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page, "/suites?suite=particl&page=boards&sp=boards");
  await page.getByTestId("tabbar-more").click();
  await expect(page.getByTestId("tabbar-more")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("tabbar-assets").click();
  await expect(page.getByTestId("tabbar-assets")).toHaveAttribute("aria-current", "page");
  const library = page.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByTestId("library-assets")).toContainText("harbour-plate.webp");
  expect(errors).toEqual([]);
});

test("Run stage opens the page's Atomik plan with what stops it; Escape closes it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=particl&page=deliver&sp=deliver");
  await expect(page.getByTestId("page-title")).toHaveText("Deliver");
  await page.getByTestId("primary-action").click();
  const sheet = page.getByTestId("atomik-panel");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("atomik-plan-title")).not.toBeEmpty();
  /* Whatever the engine did with the press is on screen: a refusal, a reason, steps or the gate. */
  await expect(sheet.locator("[data-testid='atomik-notice'], [data-testid='atomik-reason'], [data-testid='atomik-step'], [data-testid='atomik-gate']").first()).toBeVisible();
  await expect(page.getByTestId("atomik-run")).toBeVisible();
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, "[data-testid='atomik-panel']"), "targets under 44×44").toEqual([]);
    const tiny = await sheet.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) && Number.parseFloat(getComputedStyle(el).fontSize) < 12)
      .map((el) => `${getComputedStyle(el).fontSize}: ${el.textContent?.slice(0, 30)}`));
    expect(tiny, "text under 12px").toEqual([]);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Library › Tools: a Deliver row opens its tool; Business and Viral offer Assets only", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "the Library is a column from 1280px");
  const errors = await open(page, "/suites?suite=particl&page=deliver&sp=deliver");
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Tools/ }).click();
  await library.getByRole("button", { name: /^Master/ }).click();
  await expect(page.getByTestId("stage-work")).toHaveAttribute("data-tool", "movie");

  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Viral" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Motion Transfer");
  await expect(library.getByRole("tab", { name: /Tools/ })).toHaveCount(0);
  await expect(library.getByTestId("library-assets")).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: the Studio grid counts the project as saved now, not as first loaded", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const store = { current: fixture() };
  const errors = await open(page, "/suites?suite=particl&page=deliver&sp=deliver", store);
  await page.getByTestId("tabbar-home").click();
  await page.getByTestId("home-suite-studio").click();
  await expect(page.getByTestId("home-stage-brief")).toContainText("5 words");
  /* Another stage (or a teammate) saves the brief; the grid reads it when it opens again. */
  store.current = { ...store.current, brief: "A fox crosses the frozen harbour at dusk and meets the keeper" };
  await page.getByTestId("home-stage-takes").click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("home-stage-brief")).toContainText("12 words");
  expect(errors).toEqual([]);
});

test("Takes: an audio take opens its transcript; the picture tools stay with pictures", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=particl&page=takes&sp=takes");
  await expect(page.getByTestId("edit-stage")).toBeVisible();
  await page.getByTestId("edit-takes").locator("[data-testid='edit-take'][data-media='audio']").click();
  await expect(page.getByTestId("transcribe")).toBeVisible();
  await expect(page.getByTestId("edit-to-timeline")).toHaveCount(0);
  await expect(page.getByTestId("edit-image")).toHaveCount(0);
  expect(errors).toEqual([]);
});
