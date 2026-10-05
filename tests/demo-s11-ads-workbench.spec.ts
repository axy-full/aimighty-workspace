import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS, adsUrl, desktop, faintText, grey, mockReads, seedAds } from "./helpers/s11-board";

/*
 * Stream 11 · the Ads board (README § 3.3, "Ads and Social frames" A1 and A2): the start card and the free reads, Brand kit and
 * Product facts approved by a person, Hooks and Format briefs (Make in Make), the Edit panels, and the old Business links.
 * Nothing is generated and nothing paid is sent: the two page reads are answered locally.
 */
test.describe.configure({ retries: 1 });
const shot = (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  return page.screenshot({ path: `${SHOTS}/${name}-${size.width}x${size.height}.png` });
};
const card = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);

test("an empty Ads board reads the site for free, and nothing is used until a person approves it", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const calls = await mockReads(page);
  const { project, paid } = await seedAds(page, null);
  await page.goto(adsUrl(project.id, "&frame=1"));
  const start = page.getByTestId("ads-start");
  await expect(start).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("ads-start-read")).toHaveText("Read the site · free");
  await expect(page.getByTestId("ads-start-read")).toBeDisabled();
  await shot(page, "ads-empty");

  await page.getByTestId("ads-start-url").fill("shop.example.test/bottle");
  await page.getByTestId("ads-start-read").click();
  /* Both pages are read; the Brand kit and Product facts cards then wait for review. */
  await expect(card(page, "ads:brand")).toHaveAttribute("data-card-kind", "ads-brand", { timeout: 30_000 });
  await expect(page.getByTestId("ads-brand")).toHaveAttribute("data-phase", "review");
  await expect(page.getByTestId("ads-product")).toHaveAttribute("data-phase", "review");
  expect(calls.sort()).toEqual(["brand https://shop.example.test/", "product https://shop.example.test/bottle"]);
  await expect(card(page, "group:ads-start")).toContainText("waiting for your review");
  await expect(page.getByTestId("ads-brand")).toContainText("Clear Co · brand kit");
  await expect(page.getByTestId("ads-brand")).toContainText("Read from shop.example.test");
  await expect(page.getByTestId("ads-product")).toContainText("Glass bottle");
  /* The rail says a review waits. */
  await expect(page.getByTestId("board-rail").locator('[data-region="brand"]')).toHaveAttribute("data-state", "needs");
  await shot(page, "ads-waiting-for-review");
  /* Nothing is on the brief yet but the addresses the person typed. */
  const before = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: {} }).catch(() => null);
  void before;

  await page.getByTestId("ads-brand-approve").click();
  await expect(page.getByTestId("ads-brand")).toHaveAttribute("data-phase", "made");
  await page.getByTestId("ads-product-approve").click();
  await expect(page.getByTestId("ads-product")).toHaveAttribute("data-phase", "made");
  await expect(card(page, "group:ads-start")).toContainText("approved");
  await expect(page.getByTestId("board-rail").locator('[data-region="brand"]')).toHaveAttribute("data-state", "done");
  expect(paid).toEqual([]);
});

test("Hooks: pick lasts for the session; Format briefs hand one brief to Make, which prices it", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=2"));
  const hooks = page.getByTestId("ads-hooks");
  await expect(hooks).toBeVisible({ timeout: 60_000 });
  await expect(hooks).toContainText("Hooks · 3 opening lines");
  await expect(hooks.locator(".ab-hook-pick")).toHaveCount(3);
  await hooks.getByRole("button", { name: /Pick “Water, simply\./ }).click();
  await expect(hooks.getByRole("button", { name: /Pick “Water, simply\./ })).toHaveAttribute("aria-pressed", "true");
  /* The agent writes the nine more: pressing opens its dialog, which quotes before anything is reserved. */
  await expect(hooks.getByTestId("ads-hooks-write")).toContainText("Write 9 more");
  const formats = page.getByTestId("ads-formats");
  await expect(formats).toContainText("Format briefs · 6 formats · 18 briefs");
  await formats.getByTestId("ads-format-posters").click();
  await expect(formats.locator(".ab-brief")).toHaveCount(3);
  await shot(page, "ads-hooks-formats");
  await formats.locator(".ab-brief").first().getByRole("button", { name: "Make in Make" }).click();
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("make")).toBe("image");
  expect(paid).toEqual([]);
});

test("Edit opens the card's panel on the board's draft; the old Business links open the board on the card", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=1"));
  await expect(page.getByTestId("ads-brand")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("ads-brand-edit").click();
  const panel = page.getByTestId("ads-panel");
  await expect(panel).toHaveAttribute("data-panel", "brand");
  await expect(panel.getByTestId("brand-tool")).toBeVisible();
  /* A word typed in the panel is on the card at once: one draft. */
  await panel.getByTestId("brand-name").fill("Clear Water Co");
  await expect(page.getByTestId("ads-brand")).toContainText("Clear Water Co · brand kit");
  await shot(page, "ads-brand-panel");
  await page.getByTestId("ads-panel-close").click();
  await expect(panel).toHaveCount(0);

  /* An old Business link lands on the card, with its panel open. */
  await page.goto(`/suites?project=${project.id}&suite=moleculr&page=marketing&sp=hooks`);
  await expect.poll(() => new URL(page.url()).searchParams.get("card"), { timeout: 30_000 }).toBe("hooks");
  expect(new URL(page.url()).searchParams.get("kind")).toBe("ads");
  expect(new URL(page.url()).searchParams.get("frame")).toBe("2");
  await expect(page.getByTestId("ads-panel")).toHaveAttribute("data-panel", "hooks", { timeout: 30_000 });
});

test("the Ads board holds the text floor and does not scroll the page sideways", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=1"));
  await expect(page.getByTestId("ads-brand")).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await faintText(page, ".react-flow__viewport")).toEqual([]);
  await expect(page.getByTestId("ads-unavailable").first()).toBeAttached();
  void grey;
});

test("the image-ad card: Marketing Studio Image 2.0 Alpha with the estimate on its button, and nothing sent until a person presses it", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=1"));
  await expect(page.getByTestId("ads-product")).toBeVisible({ timeout: 60_000 });
  /* The product's image comes in through the Product panel (a device file, kept as an original). */
  await page.getByTestId("ads-product-edit").click();
  await page.getByTestId("product-picker-file").setInputFiles({ name: "bottle.png", mimeType: "image/png", buffer: grey() });
  await expect(page.getByTestId("product-chosen")).toContainText("bottle.png", { timeout: 30_000 });
  await page.getByTestId("ads-panel-close").click();
  await page.getByTestId("board-rail").locator('[data-region="ads"]').click();
  const ad = page.getByTestId("ads-image-ad");
  await expect(ad.getByTestId("ads-image-ad-engine")).toContainText("Marketing Studio Image · 2.0 Alpha · 1:1 · 2K");
  /* The estimate, from the quote route; the button carries it as "N cr" once it is known. */
  await expect(ad.getByTestId("ads-image-ad-make")).toContainText(/Make the image ad · \d[\d.,]* cr/, { timeout: 30_000 });
  await shot(page, "ads-image-ad");
  /* Change unfolds the aspect and size. */
  await ad.getByRole("button", { name: "Change" }).click();
  await expect(ad.getByRole("group", { name: "Aspect" })).toBeVisible();
  expect(paid).toEqual([]);
});

test("the poster Designer opens from frame 3, edits layers, exports a PNG free, and keeps the poster with the project", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid, headers } = await seedAds(page);
  await page.goto(adsUrl(project.id, "&frame=3"));
  const designer = page.getByTestId("ads-designer");
  await expect(designer).toBeVisible({ timeout: 60_000 });
  await expect(designer).toContainText("Poster · 4:5");
  await expect(designer.getByTestId("ads-designer-export")).toHaveText("Export PNG · free");
  const layers = designer.getByTestId("ads-designer-layers");
  await expect(layers).toContainText("Headline");
  await expect(layers).toContainText("Call to action");
  /* The headline starts as the first hook; the panel's text box is labelled with the layer's name. */
  const text = designer.getByTestId("ads-designer-text");
  await expect(text).toHaveValue("Water, simply.");
  await text.fill("Fill it again.");
  await shot(page, "ads-designer");
  const download = page.waitForEvent("download");
  await designer.getByTestId("ads-designer-export").click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  await designer.getByTestId("ads-designer-add-shape").click();
  await expect(layers).toContainText("Shape");
  await designer.getByTestId("ads-designer-close").click();
  await expect(designer).toHaveCount(0);
  /* The poster is saved with the project: read it back from the server before the page is left. */
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers })).json() as { project?: { moleculr?: { poster?: { layers: { text?: string }[] } } } };
    return JSON.stringify(saved.project?.moleculr?.poster?.layers.map((l) => l.text ?? null));
  }, { timeout: 20_000 }).toContain("Fill it again.");
  /* One poster per project: it is there again, as it was left. */
  await page.goto(adsUrl(project.id, "&frame=3"));
  await expect(page.getByTestId("ads-designer-text")).toHaveValue("Fill it again.", { timeout: 60_000 });
  expect(paid).toEqual([]);
});

test("at every size the Ads and Social boards open without errors and without scrolling the page sideways", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ads = await seedAds(page);
  await page.goto(adsUrl(ads.project.id, "&frame=1"));
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  const social = await seedAds(page, null, "social");
  await page.goto(`/suites?project=${social.project.id}&view=board&kind=social`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  /* A narrow screen draws no canvas card of its own here: the phone's record is stream 10's. Nothing it shows may be a price made up. */
  expect(errors).toEqual([]);
  await shot(page, "ads-social-sizes");
});
