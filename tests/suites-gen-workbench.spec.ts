import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Suites › Gen, build step 2 (design/particl-suites/README.md › Gen): the
 * composer on the existing useComposer host, the prompt enhancer with its
 * live price on the button, per-second length, the model sheet, and the
 * Library's assets dragged in as references.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-gen", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })],
  });
  /* A dropped asset is verified with the server before it becomes a reference. */
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } }));
  await page.route(/\/api\/uploads\/up_plate\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_plate", filename: "harbour-plate.webp" }) } }));
  const enhance: Record<string, unknown>[] = [];
  await page.route("**/api/prompt/enhance", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    enhance.push(body);
    if (body.quoteOnly) return route.fulfill({ json: { model: "anthropic/claude-haiku-4.5", effort: "auto", estimateCredits: 1 } });
    if (body.maxCredits !== 1) return route.fulfill({ status: 409, json: { error: "The writing estimate changed. Review the new quote before running." } });
    return route.fulfill({ json: { prompt: `${body.prompt}, slow push in, rim light, tack sharp`, provider: "higgsfield", writer: "anthropic/claude-haiku-4.5" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, enhance };
}

test("Enhance wears its live price, approves exactly that, and the card offers Use this / Keep mine", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, enhance } = await open(page);
  const button = page.getByTestId("enhance");
  await expect(button).toBeDisabled();
  await expect(page.getByTestId("enhance-reason")).toHaveText("Write a few words first.");

  /* raw: is never priced and never sent. */
  await page.getByTestId("gen-prompt").fill("raw: exactly these words");
  await expect(page.getByTestId("enhance-reason")).toHaveText("raw: is sent as written.");
  await expect(button).toBeDisabled();
  expect(enhance).toHaveLength(0);

  await page.getByTestId("gen-prompt").fill("@Image1 a fox crossing a frozen harbour");
  await expect(button).toHaveText("Enhance · 1 cr");
  expect(enhance.at(-1)).toMatchObject({ quoteOnly: true, mode: "video", prompt: "@Image1 a fox crossing a frozen harbour" });
  await button.click();
  const card = page.getByTestId("enhanced-card");
  await expect(card).toContainText("Enhanced · Higgsfield · 1 cr");
  await expect(card).toContainText("@Image1 a fox crossing a frozen harbour, slow push in, rim light, tack sharp");
  expect(enhance.at(-1)).toMatchObject({ maxCredits: 1, mode: "video" });
  expect(enhance.at(-1)).not.toHaveProperty("quoteOnly");

  /* Keep mine leaves the words alone; Use this replaces them. */
  await page.getByTestId("enhanced-keep").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("gen-prompt")).toHaveValue("@Image1 a fox crossing a frozen harbour");
  await button.click();
  await page.getByTestId("enhanced-use").click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue(/slow push in, rim light, tack sharp$/);
  expect(errors).toEqual([]);
});

test("length is every second the engine allows, the sheet lists both catalogues, and an asset drags in as a reference", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors } = await open(page);

  const length = page.getByTestId("gen-length");
  await expect(length).toBeVisible();
  const seconds = await length.locator("option").evaluateAll((options) => options.map((o) => Number((o as HTMLOptionElement).value)));
  expect(seconds.length).toBeGreaterThan(3);
  expect(seconds).toEqual(Array.from({ length: seconds.length }, (_, i) => seconds[0] + i));
  await length.selectOption(String(seconds.at(-1)));
  await expect(length).toHaveValue(String(seconds.at(-1)));

  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await expect(sheet.getByRole("tab")).toHaveText(["Studio engines", "Higgsfield catalogue"]);
  await expect(sheet.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "Close" }).click().catch(() => {});
  await expect(sheet).toHaveCount(0);

  /* The Library opens on Assets in Gen; its tile's text/plain id lands in the well. */
  if (!wide) await page.getByTestId("toggle-library").click();
  const tile = page.getByTestId("library").locator("[data-ctx^='asset:']").first();
  await expect(tile).toBeVisible();
  const id = (await tile.getAttribute("data-ctx"))!.slice("asset:".length);
  if (!wide) await page.getByTestId("close-library").click();
  await page.getByTestId("gen-well").evaluate((well, payload) => {
    const data = new DataTransfer();
    data.setData("text/plain", payload);
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, id);
  await expect(page.getByTestId("gen-well")).toContainText(/@Image1 · /);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("the Gen composer keeps the phone floors", async ({ page }, info) => {
  test.skip(WIDE.includes(info.project.name) || !SIZES.includes(info.project.name), "the three phone viewports");
  await open(page);
  await page.getByTestId("gen-prompt").fill("a fox crossing a frozen harbour");
  await expect(page.getByTestId("enhance")).toHaveText("Enhance · 1 cr");
  await page.getByTestId("enhance").click();
  await expect(page.getByTestId("enhanced-card")).toBeVisible();
  await page.getByTestId("gen-view").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".gx-gen"), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".gx-gen"), "labels under #7C7C84").toEqual([]);
});

test("Gen › Edit hosts Seedance Edit on this workspace's credits, 2.5 by default, 2.0 on the picker", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page);
  await page.getByTestId("gen-tab-edit").click();
  await expect(page.getByTestId("gen-edit")).toContainText("Change something inside an existing shot");
  const panel = page.getByTestId("seedance-edit");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-model", "dreamina-seedance-2-5-260628");
  await expect(panel).toContainText("Seedance 2.5 Edit");
  await page.getByTestId("gen-edit-model-20").click();
  await expect(page.getByTestId("seedance-edit")).toHaveAttribute("data-model", "dreamina-seedance-2-0-260128");
  await expect(page.getByTestId("seedance-edit")).toContainText("Seedance 2.0 Edit");
  await expect(page.getByTestId("gen-edit")).toContainText("untested here");
  await page.getByRole("tab", { name: "Video" }).click();
  await expect(page.getByTestId("gen-prompt")).toBeVisible();
  expect(errors).toEqual([]);
});
