import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";
import { openAsTabs, redesignWithBoards } from "./helpers/v12Header";

/*
 * The new interface's header layout (components/v12/shell/header.css; design/particl-prototype-25, "one shared top bar"): the
 * ⌘K bar is on the right, directly left of the Activity pill and the avatar, a fixed 280 px at 1280, 320 at 1440 and 360 at 1920,
 * 160 px wider while it has focus (owner, 14 Oct: v25 replaces the 11 Oct flexible field). The right group is pinned to the edge, so
 * nothing moves as boards open or close; the tabs give way. No horizontal overflow at any desktop size; phones keep the phone app.
 */
const rect = (page: Page, id: string) => page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: r.width, h: r.height }; });
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.describe("desktop", () => {
  test.beforeEach(({}, info) => { test.skip(isCompact(info), "the new header is desktop-only"); });

  test("the ⌘K bar is 280, 320 and 360 px, right beside the Activity pill, and 160 px wider on focus, at 1280, 1440 and 1920", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await openAsTabs(page, ids);
    const height = page.viewportSize()!.height;
    for (const [width, bar] of [[1280, 280], [1440, 320], [1920, 360]] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await rect(page, "v12-header")).w).toBeGreaterThanOrEqual(width - 1);
      await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(bar, 0);
      const [tabs, field, activity, avatar, header] = await Promise.all(["v12-tabs", "v12-atomik-field", "v12-activity", "v12-avatar", "v12-header"].map((id) => rect(page, id)));
      /* Pinned right at every width: the avatar ends at the header's right padding, the Activity pill is beside it. */
      expect(width - avatar.r, `${width}: the avatar is at the right edge`).toBeLessThanOrEqual(17);
      expect(avatar.x - activity.r, `${width}: the Activity pill is beside the avatar`).toBeLessThanOrEqual(17);
      /* The bar is directly left of the pill, after the tabs. */
      expect(activity.x - field.r, `${width}: the bar is directly left of the Activity pill`).toBeLessThanOrEqual(17);
      expect(activity.x - field.r, `${width}: the bar ends before the Activity pill`).toBeGreaterThanOrEqual(-1);
      expect(field.x, `${width}: the bar is after the tabs`).toBeGreaterThanOrEqual(tabs.r);
      /* One row, inside the header. */
      for (const part of [tabs, field, activity, avatar]) { expect(part.y).toBeGreaterThanOrEqual(header.y); expect(part.b).toBeLessThanOrEqual(header.b + 1); }
      await noOverflow(page);
      /* Focus widens it by 160 px, to the left; the pill does not move. */
      await page.getByTestId("v12-ask").focus();
      await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(bar + 160, 0);
      expect((await rect(page, "v12-activity")).x).toBeCloseTo(activity.x, 0);
      await noOverflow(page);
      await page.getByTestId("v12-ask").blur();
      await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(bar, 0);
    }
  });

  test("the pinned pair and the bar stay put as boards open, and the tabs give way", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips", "Spring spot", "Harbour cut", "Ridge reel"]);
    await openAsTabs(page, ids.slice(0, 1));
    const before = await rect(page, "v12-avatar");
    const beforeField = await rect(page, "v12-atomik-field");
    await openAsTabs(page, ids);
    const after = await rect(page, "v12-avatar");
    const afterField = await rect(page, "v12-atomik-field");
    expect(after.r).toBeCloseTo(before.r, 0);
    expect(afterField.w).toBeCloseTo(beforeField.w, 0);
    expect(afterField.x).toBeCloseTo(beforeField.x, 0);
    await noOverflow(page);
  });

  test("with ten boards open at 1280, focusing the ⌘K bar widens it 160 px and the tabs give way: no overflow, nothing clipped mid-word, the bar clear of the tabs", async ({ page }) => {
    test.setTimeout(240_000);
    const names = Array.from({ length: 10 }, (_, i) => `Board ${i + 1} with a long working title`);
    const { ids } = await redesignWithBoards(page, names);
    await openAsTabs(page, ids);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(280, 0);
    await page.getByTestId("v12-ask").focus();
    await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(440, 0);
    await noOverflow(page);
    const [nav, field, activity] = await Promise.all(["v12-tabs", "v12-atomik-field", "v12-activity"].map((id) => rect(page, id)));
    expect(nav.r, "the tabs end before the bar").toBeLessThanOrEqual(field.x + 1);
    expect(field.r, "the bar ends before the Activity pill").toBeLessThanOrEqual(activity.x + 1);
    /* Everything in the tab group is whole inside it: a tab may end in an ellipsis, but is never cut by the group's edge. */
    const parts = await page.getByTestId("v12-tabs").evaluate((el) => {
      const box = el.getBoundingClientRect();
      return [...el.children].map((child) => { const r = child.getBoundingClientRect(); return { right: r.right - box.right, text: (child.textContent ?? "").trim().slice(0, 24), clipped: (child.querySelector(".v12-tab-label") as HTMLElement | null)?.scrollWidth ?? 0 } ; });
    });
    for (const part of parts) expect(part.right, `${part.text}: inside the group`).toBeLessThanOrEqual(1);
    /* The + button is still there and clickable. */
    await expect(page.getByTestId("v12-tab-plus")).toBeVisible();
    await page.getByTestId("v12-ask").blur();
    await expect.poll(async () => (await rect(page, "v12-atomik-field")).w).toBeCloseTo(280, 0);
  });

  test("each board's tab carries a letter tile, its name and a status dot", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "launch clips"]);
    await openAsTabs(page, ids);
    const tab = page.locator(`[data-testid="v12-tab-board"][data-id="${ids[1]}"]`);
    await expect(tab.locator(".v12-tab-tile")).toHaveText("L");
    await expect(tab.locator(".v12-tab-label")).toHaveText("launch clips");
    await expect(tab.locator(".v12-tab-dot")).toBeVisible();
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
