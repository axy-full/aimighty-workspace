import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { floors, noBannedNames } from "./helpers/r1-gaps";
import { SHOTS, desktop, shoot, watchErrors } from "./helpers/gaps-l3";
import { adsUrl, seedAds } from "./helpers/s11-board";
import { mkdirSync } from "node:fs";

/*
 * Gap screens, lane 3 · the empty Ads and Social boards on first open (Gaps B frames, "Ads and Social"): one question, one
 * action, and a row under the box. Ads: a product page or a brand site, read for free, and three of the code's own ad templates.
 * Social: a long video, kept whole, and the two quick tools that exist. Nothing here spends; there is no sample brand or person.
 * The canvas is the desktop's: phone widths open the project's Record, so they skip.
 */
const NAMED_PHONE = "the canvas is the desktop's; phone widths open the project's Record (phone specs own them)";

test("an empty Ads board asks one question, offers one action and a template row; a template starts the brief, free", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const errors = watchErrors(page);
  const { project, paid } = await seedAds(page, null);
  await page.goto(adsUrl(project.id));
  const start = page.getByTestId("ads-start");
  await expect(start).toBeVisible({ timeout: 60_000 });
  await expect(start.getByRole("heading")).toHaveText("What are we advertising?");
  await expect(page.getByTestId("ads-start-url")).toHaveAttribute("placeholder", "Paste a product page or a brand site");
  await expect(page.getByTestId("ads-start-read")).toHaveText("Read the site · free");
  await expect(page.getByTestId("ads-start-read")).toBeDisabled();
  await expect(page.getByTestId("ads-start-template")).toHaveText(["Launch announcement", "Hero statement", "Talking head"]);
  await expect(start).not.toContainText(/Maison|Aurel|Northline|\bcr\b/);
  await noBannedNames(page, '[data-testid="ads-start"]');
  await floors(page, '[data-testid="ads-start"]', false);
  mkdirSync(SHOTS, { recursive: true });
  await shoot(page, info.project.name, "ads-empty");

  await page.getByTestId("ads-start-template").nth(0).click();
  await expect(page.getByTestId("ads-start")).toHaveCount(0);
  await expect(page.locator("body")).toContainText("Format briefs");
  expect(paid, "choosing a template spends nothing").toEqual([]);
  expect(errors).toEqual([]);
});

test("an empty Social board asks for a long video, keeps it whole, and offers the two quick tools; nothing is made", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { project, paid } = await seedAds(page, null, "social");
  await page.goto(`/suites?project=${project.id}&view=board&kind=social`);
  const start = page.getByTestId("social-start");
  await expect(start).toBeVisible({ timeout: 60_000 });
  await expect(start.getByRole("heading")).toHaveText("What are we cutting?");
  await expect(start.getByTestId("social-start-drop")).toContainText("Drop a long video here");
  await expect(page.getByTestId("social-start-upload")).toHaveText("Add the source · free");
  await expect(start.getByTestId("social-start-tools").getByRole("button")).toHaveText(["Motion transfer", "Object swap"]);
  await expect(start).not.toContainText(/Podcast|Event recap|Narrated|\bcr\b/);
  await noBannedNames(page, '[data-testid="social-start"]');
  await floors(page, '[data-testid="social-start"]', false);
  await shoot(page, info.project.name, "social-empty");

  await page.getByTestId("social-start-motion").click();
  await expect(page).toHaveURL(/make=motion/);
  expect(paid).toEqual([]);
});

test("a long video added on the Social start is filed with its original kept", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { project, paid } = await seedAds(page, null, "social");
  await page.goto(`/suites?project=${project.id}&view=board&kind=social`);
  await expect(page.getByTestId("social-start")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("social-start-file").setInputFiles({ name: "walk.mp4", mimeType: "video/mp4", buffer: readFileSync("public/fixtures/clip.mp4") });
  await expect(page.getByTestId("social-start")).toHaveCount(0, { timeout: 60_000 });
  expect(paid).toEqual([]);
});
