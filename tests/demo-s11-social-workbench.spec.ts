import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { SHOTS, desktop, faintText, seedAds } from "./helpers/s11-board";

/*
 * Stream 11 · the Social board (README § 3.3, "Ads and Social frames" S1 and S2), on what exists today: the source video,
 * Effects (Motion transfer and Object swap, opened in Make with the source loaded) and History. Clips, hook review, narrated
 * video and posts read "Not in Particl yet", with no price and no sample result. Nothing is generated or sent.
 */
test.describe.configure({ retries: 1 });
const shot = (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!;
  return page.screenshot({ path: `${SHOTS}/${name}-${size.width}x${size.height}.png` });
};
const CLIP = () => ({ name: "walk.mp4", mimeType: "video/mp4", buffer: readFileSync("public/fixtures/clip.mp4") });
const url = (id: string, extra = "") => `/suites?project=${id}&view=board&kind=social${extra}`;

test("an empty Social board takes the source video; the source opens Motion transfer in Make with it loaded", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedAds(page, null, "social");
  await page.goto(url(project.id, "&frame=1"));
  await expect(page.getByTestId("social-start")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("social-start-upload")).toHaveText("Add the source · free");
  await shot(page, "social-empty");
  await page.getByTestId("social-start-file").setInputFiles(CLIP());

  const source = page.getByTestId("social-source");
  await expect(source).toBeVisible({ timeout: 60_000 });
  await expect(source).toContainText("walk.mp4");
  await expect(source).toContainText("Upload · original kept");
  await expect(source).toContainText("SOURCE · 0:10");
  await expect(page.locator('[data-card-id="group:social-source"]')).toContainText("Source");
  /* What is not built says so, with no figure and no sample. */
  await expect(page.getByTestId("social-unavailable")).toHaveCount(4);
  await expect(page.getByTestId("social-unavailable").first()).toContainText("Not in Particl yet");
  await expect(page.getByTestId("board-rail").locator('[data-region="source"]')).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("board-rail").locator('[data-region="clips"]')).toHaveAttribute("data-state", "empty");
  await shot(page, "social-source");

  await source.getByTestId("social-source-motion").click();
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "motion", { timeout: 30_000 });
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4", { timeout: 30_000 });
  expect(paid).toEqual([]);
});

test("Effects opens each quick tool in Make; History is today's History view in the board's drawer", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedAds(page, null, "social");
  await page.goto(url(project.id));
  await expect(page.getByTestId("social-start")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("social-start-file").setInputFiles(CLIP());
  await expect(page.getByTestId("social-source")).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("board-rail").locator('[data-region="effects"]').click();
  const effects = page.getByTestId("social-effects");
  await expect(effects).toContainText("Effects");
  await expect(effects).not.toContainText(/\bcr\b|\$/);
  await effects.getByTestId("social-effects-swap").click();
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "swap", { timeout: 30_000 });

  await page.getByTestId("board-drawer-history").click();
  const history = page.getByTestId("board-history");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("history-view")).toBeVisible({ timeout: 30_000 });
  await expect(history.getByTestId("history-empty")).toContainText("No takes in this project yet.");
  await shot(page, "social-history");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(await faintText(page, ".react-flow__viewport")).toEqual([]);
  expect(paid).toEqual([]);
});
