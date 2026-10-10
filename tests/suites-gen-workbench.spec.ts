import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Suites › Make (design/particl-graphite/README.md § 3.2; it was Gen): the
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
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Coastal light study");
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
  await expect(button).toHaveText("Enhance now · 1 cr");
  expect(enhance.at(-1)).toMatchObject({ quoteOnly: true, mode: "video", prompt: "@Image1 a fox crossing a frozen harbour" });
  await button.click();
  const card = page.getByTestId("enhanced-card");
  await expect(card).toContainText("Enhanced · Standard · 1 cr");
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

test("length is every second the engine allows, the sheet lists Studio engines only, and an asset drags in as a reference", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);

  const length = page.getByTestId("gen-length");
  await expect(length).toBeVisible();
  const seconds = await length.locator("option").evaluateAll((options) => options.map((o) => Number((o as HTMLOptionElement).value)));
  expect(seconds.length).toBeGreaterThan(3);
  expect(seconds).toEqual(Array.from({ length: seconds.length }, (_, i) => seconds[0] + i));
  await length.selectOption(String(seconds.at(-1)));
  await expect(length).toHaveValue(String(seconds.at(-1)));

  /* Change lists the engines under it (already open under Advanced). */
  const sheet = page.getByTestId("make-engines");
  /* One source since 28 September 2026: no signed-in account's catalogue, so no switch. */
  await expect(sheet.getByRole("tab")).toHaveCount(0);
  await expect(sheet).not.toContainText(/Higgsfield|connected/i);
  await expect(sheet.getByTestId("make-engine-row").first()).toBeVisible();
  await page.getByTestId("gen-model").click();
  await expect(sheet).toHaveCount(0);

  /* Recent holds the project's assets; a card's text/plain id lands in the well when dropped there. */
  await page.getByTestId("make-tab-recent").click();
  const tile = page.getByTestId("make-panel").locator("[data-ctx^='asset:']").first();
  await expect(tile).toBeVisible();
  const id = (await tile.getAttribute("data-ctx"))!.slice("asset:".length);
  await page.getByTestId("make-tab-make").click();
  await page.getByTestId("gen-well").evaluate((well, payload) => {
    const data = new DataTransfer();
    data.setData("text/plain", payload);
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, id);
  await expect(page.getByTestId("make-reference")).toHaveAttribute("title", /^@Image1 · /);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("the Gen composer keeps the phone floors", async ({ page }, info) => {
  test.skip(WIDE.includes(info.project.name) || !SIZES.includes(info.project.name), "the three phone viewports");
  await open(page);
  await page.getByTestId("gen-prompt").fill("a fox crossing a frozen harbour");
  await expect(page.getByTestId("enhance")).toHaveText("Enhance now · 1 cr");
  await page.getByTestId("enhance").click();
  await expect(page.getByTestId("enhanced-card")).toBeVisible();
  await page.getByTestId("gen-view").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".gx-make"), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".gx-make"), "labels under #7C7C84").toEqual([]);
});

/* One take on this workspace's credits, route-mocked end to end: one Studio video engine at a fixed price. */
const PRICE = 18;
const ENGINES = [
  { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p", "720p", "1080p"], ratios: ["16:9", "9:16", "1:1"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], use: "Cinematic motion from a prompt or references.", rate: { credits: PRICE, resolution: "480p", ratio: "16:9", duration: 5 } },
];
/* Longer than the 60 characters a take's name keeps: the name is cut mid-phrase, after "…desk lamp in". */
const LONG = "A slow, cinematic push in on a battered scuffed desk lamp in a dark study, dust in the beam";
test("one take is sent once, at the price on the button: Make closes and says what it came to", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  /* The take stays out of the Library read, so the card on screen is the composer's own run. */
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) =>
    route.fulfill({ json: { models: ENGINES, audio: null, credits: new URL(route.request().url()).searchParams.has("model") ? PRICE : null } }));
  let charges = 0;
  const ceilings: number[] = [];
  await page.route("**/api/generate/quote", (route) => route.fulfill({ json: { estimatedCredits: PRICE, fingerprint: "f".repeat(64), unit: "cr" } }));
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    charges++;
    ceilings.push(Number((route.request().postDataJSON() as { maxCredits?: number }).maxCredits));
    return route.fulfill({ json: { id: "gen_lamp", status: "running" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_lamp(\?.*)?$/, (route) =>
    route.fulfill({ json: { generation: generation({ id: "gen_lamp", kind: "video", status: "running", prompt: LONG }) } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Coastal light study");

  await page.getByTestId("gen-prompt").fill(LONG);
  /* The first live price can wait on a cold compile. */
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${PRICE} cr`, { timeout: 60_000 });
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => charges).toBe(1);
  /* The accepted press closes Make and says what it came to, in one line, at the price on the button. */
  await expect(page.getByTestId("toast")).toContainText(`${PRICE} cr · rendering`);
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  expect(charges).toBe(1);
  /* The figure on the button is the ceiling the press was sent with. */
  expect(ceilings).toEqual([PRICE]);
  expect(errors).toEqual([]);
});
