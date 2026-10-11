import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";
import { openAsTabs, redesignWithBoards } from "./helpers/v12Header";

/*
 * The new interface's header layout (components/v12/shell/header.css; docs/redesign/inventory.md § 5.1): the Activity pill and
 * the avatar are pinned to the right edge at every width, and the Atomik field is the flexible part after the tabs, 280 to
 * 560 px (owner, 11 Oct), so the pinned pair never moves as boards open or close. No horizontal overflow at any desktop size; phones keep the phone app.
 */
const rect = (page: Page, id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: r.width, h: r.height }; });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.describe("desktop", () => {
  test.beforeEach(({}, info) => { test.skip(isCompact(info), "the new header is desktop-only"); });

  test("the Atomik field is 280 to 560 px after the tabs, and Activity and the avatar are pinned right, at 1280, 1440 and 1920", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await openAsTabs(page, ids);
    const height = page.viewportSize()!.height;
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await rect(page, "v12-header")).w).toBeGreaterThanOrEqual(width - 1);
      const [tabs, field, activity, avatar, header] = await Promise.all(["v12-tabs", "v12-atomik-field", "v12-activity", "v12-avatar", "v12-header"].map((id) => rect(page, id)));
      /* Pinned right at every width: the avatar ends at the header's right padding, the Activity pill is beside it. */
      expect(width - avatar.r, `${width}: the avatar is at the right edge`).toBeLessThanOrEqual(17);
      expect(avatar.x - activity.r, `${width}: the Activity pill is beside the avatar`).toBeLessThanOrEqual(17);
      /* The field follows the tabs and stays between 280 and 560 px. */
      expect(field.x - tabs.r, `${width}: the field follows the tabs`).toBeLessThanOrEqual(17);
      expect(field.w, `${width}: the field's width`).toBeGreaterThanOrEqual(279.5);
      expect(field.w, `${width}: the field's width`).toBeLessThanOrEqual(560.5);
      expect(field.r, `${width}: the field ends before the Activity pill`).toBeLessThanOrEqual(activity.x + 1);
      /* One row, inside the header. */
      for (const part of [tabs, field, activity, avatar]) { expect(part.y).toBeGreaterThanOrEqual(header.y); expect(part.b).toBeLessThanOrEqual(header.b + 1); }
      await noOverflow(page);
    }
  });

  test("the pinned pair stays put as boards open, and the field gives way first, never below its minimum", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips", "Spring spot", "Harbour cut", "Ridge reel"]);
    await openAsTabs(page, ids.slice(0, 1));
    const before = await rect(page, "v12-avatar");
    const beforeField = await rect(page, "v12-atomik-field");
    await openAsTabs(page, ids);
    const after = await rect(page, "v12-avatar");
    const afterField = await rect(page, "v12-atomik-field");
    expect(after.r).toBeCloseTo(before.r, 0);
    expect(afterField.w).toBeLessThanOrEqual(beforeField.w + 1);
    expect(afterField.w).toBeGreaterThanOrEqual(279.5);
    await noOverflow(page);
  });
});

test("phone sizes keep today's phone app", async ({ page }, info) => {
  test.skip(!isCompact(info), "the desktop header is covered above");
  await redesignWithBoards(page, ["Mirror film"]);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toBeVisible();
  await expect(page.getByTestId("v12-header")).toHaveCount(0);
  await noOverflow(page);
});
