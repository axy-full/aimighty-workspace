import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";
import { openAsTabs, redesignWithBoards } from "./helpers/v12Header";

/*
 * The new interface's header layout (components/v12/shell/header.css; docs/redesign/inventory.md § 5.1): the Activity pill and
 * the avatar are pinned to the right edge, and the Atomik field is the flexible part: it fills what the tabs leave, so the
 * pinned pair never moves as boards open or close. No horizontal overflow at any desktop size; phones keep the phone app.
 */
const rect = (page: Page, id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: r.width, h: r.height }; });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.describe("desktop", () => {
  test.beforeEach(({}, info) => { test.skip(isCompact(info), "the new header is desktop-only"); });

  test("Activity and the avatar sit at the right edge; the Atomik field fills the space after the tabs", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await openAsTabs(page, ids);
    const width = page.viewportSize()!.width;
    const [tabs, field, activity, avatar, header] = await Promise.all(["v12-tabs", "v12-atomik-field", "v12-activity", "v12-avatar", "v12-header"].map((id) => rect(page, id)));
    /* Pinned right: the avatar ends at the header's right padding, and the Activity pill is right beside it. */
    expect(width - avatar.r, "the avatar is at the right edge").toBeLessThanOrEqual(17);
    expect(avatar.x - activity.r, "the Activity pill is beside the avatar").toBeLessThanOrEqual(17);
    /* Flexible: the field starts after the tabs and ends before the Activity pill, with only the header's gap between. */
    expect(field.x - tabs.r, "the field follows the tabs").toBeLessThanOrEqual(17);
    expect(activity.x - field.r, "the field runs up to the Activity pill").toBeLessThanOrEqual(17);
    expect(field.w).toBeGreaterThanOrEqual(200);
    if (width >= 1800) expect(field.w, "it fills, not a fixed 300 px").toBeGreaterThan(300);
    /* One row, inside the header. */
    for (const part of [tabs, field, activity, avatar]) { expect(part.y).toBeGreaterThanOrEqual(header.y); expect(part.b).toBeLessThanOrEqual(header.b + 1); }
    await noOverflow(page);
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
    expect(afterField.w).toBeGreaterThanOrEqual(199);
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
