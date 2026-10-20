import { test, expect, type Page } from "@playwright/test";

/*
 * The v25 stepper rail (components/v12/board/StepRail.tsx), on its test-only page app/(test)/v25-rail-parts (a 404 outside a local ENGINE_MOCK=1
 * development server): a floating panel centred in the canvas 16 px from its left edge, circles joined by a line, ✓ on done steps, the current
 * step ringed with its status, every step visible at 1280 x 800 without scrolling, fades and scrolling where they do not fit, "Add step" growing
 * the panel from its centre, readable text, and no horizontal overflow at the five widths. The steps on the page are mock data.
 */
test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-rail-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-rail-film")).toBeVisible();
});

const film = (page: Page) => page.getByTestId("v25-rail-film");
const rail = (page: Page, scope = film(page)) => scope.getByTestId("v12-steprail");
const steps = (page: Page, scope = film(page)) => scope.locator(".v12-steprail-step");

test("ten steps, each with its label; done steps show a tick, the current step is ringed and says its status", async ({ page }) => {
  await expect(steps(page)).toHaveCount(10);
  await expect(steps(page).locator(".v12-steprail-label")).toHaveText(["Treatment", "Brief", "Script", "Cast", "Locations", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]);
  await expect(film(page).getByTestId("v12-steprail-tick")).toHaveCount(7);
  const current = film(page).locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Shots");
  await expect(film(page).getByTestId("v12-steprail-status")).toHaveText("3 of 8 ready · 1 in work");
  await expect(current.locator(".v12-steprail-circle")).toHaveCSS("border-top-color", "rgb(10, 132, 255)");
  /* Not started steps are muted: no status line of their own. */
  await expect(film(page).getByTestId("v12-steprail-status")).toHaveCount(1);
});

test("a click or Enter makes a step current; the tooltip carries every step's status", async ({ page }) => {
  await steps(page).nth(8).click();
  await expect(page.getByTestId("v25-rail-now").first()).toHaveText("edit");
  await expect(steps(page).nth(8)).toHaveAttribute("aria-current", "step");
  await steps(page).nth(0).hover();
  const tip = page.getByTestId("v12-tooltip");
  await expect(tip).toContainText("Treatment");
  await expect(tip).toContainText("Optional · Done");
  await steps(page).nth(1).focus();
  await page.keyboard.press("Tab");
  await expect(steps(page).nth(2)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("v25-rail-now").first()).toHaveText("script");
});

test("the panel is centred in the canvas, 16 px from its left edge, and hugs its steps", async ({ page }) => {
  const frame = (await film(page).boundingBox())!;
  const box = (await rail(page).boundingBox())!;
  expect(box.x - frame.x, "16 px from the left").toBeCloseTo(16, 0);
  expect(Math.abs((box.y + box.height / 2) - (frame.y + frame.height / 2)), "centred up and down").toBeLessThanOrEqual(1);
  expect(box.width).toBeCloseTo(92, 0);
});

test("at 1280 x 800 all ten steps and Add step fit without scrolling, 26 px circles; at 1440 x 900 they are 30 px", async ({ page }) => {
  const size = page.viewportSize()!;
  test.skip(size.width < 1000, "the rail is for the desktop board");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => film(page).locator(".v12-steprail-scroll").evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(film(page).locator(".v12-steprail-circle").first()).toHaveCSS("width", "26px");
  await expect(film(page).getByTestId("v12-steprail-add")).toBeVisible();
  await expect(film(page).locator(".v12-steprail-fade")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(film(page).locator(".v12-steprail-circle").first()).toHaveCSS("width", "30px");
  await expect.poll(() => film(page).locator(".v12-steprail-scroll").evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
});

test("fifteen steps scroll inside the panel, with a fade where more is hidden, and the current step is in view", async ({ page }) => {
  const many = page.getByTestId("v25-rail-many");
  await many.scrollIntoViewIfNeeded();
  const scroll = many.locator(".v12-steprail-scroll");
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await expect(many.locator('.v12-steprail-fade[data-edge="bottom"], .v12-steprail-fade[data-edge="top"]').first()).toBeVisible();
  const current = (await many.locator('[aria-current="step"]').boundingBox())!;
  const panel = (await rail(page, many).boundingBox())!;
  expect(current.y).toBeGreaterThanOrEqual(panel.y - 1);
  expect(current.y + current.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
  /* Scrolled to the end, the top fade appears and the bottom one goes. */
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(many.locator('.v12-steprail-fade[data-edge="top"]')).toBeVisible();
  await expect(many.locator('.v12-steprail-fade[data-edge="bottom"]')).toHaveCount(0);
});

test("Add step puts another step at the end and the panel grows from its centre", async ({ page }) => {
  /* Measured against the frame, so the page scrolling to the button does not count. */
  const centre = async () => { const f = (await film(page).boundingBox())!, r = (await rail(page).boundingBox())!; return { mid: r.y + r.height / 2 - f.y, height: r.height }; };
  const before = await centre();
  await film(page).getByTestId("v12-steprail-add").click();
  await expect(steps(page)).toHaveCount(11);
  await expect.poll(async () => Math.abs((await centre()).mid - before.mid)).toBeLessThanOrEqual(2);
  /* The 11 steps still fit the canvas (spacing tightened) or scroll inside the panel; the panel never leaves the frame. */
  const f = (await film(page).boundingBox())!, r = (await rail(page).boundingBox())!;
  expect(r.y).toBeGreaterThanOrEqual(f.y);
  expect(r.y + r.height).toBeLessThanOrEqual(f.y + f.height + 1);
});

test("every word on the rail is 12 px or more, the steps are 44 px tall, and there is no horizontal overflow", async ({ page }, info) => {
  const small = await page.evaluate(() => [...document.querySelectorAll(".v12-steprail *")].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()) && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${el.className}: ${getComputedStyle(el).fontSize}`));
  expect(small, "text under 12 px").toEqual([]);
  for (const box of await steps(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no horizontal overflow at ${info.project.name}`).toBeLessThanOrEqual(0);
});

test("a label too long for the panel ends in an ellipsis, and its tooltip says the whole name", async ({ page }) => {
  const many = page.getByTestId("v25-rail-many");
  await many.scrollIntoViewIfNeeded();
  const label = many.locator(".v12-steprail-step", { hasText: "A long step name" }).locator(".v12-steprail-label");
  await label.scrollIntoViewIfNeeded();
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth), "the name is cut").toBe(true);
  expect(await label.evaluate((el) => el.getBoundingClientRect().width), "within the panel").toBeLessThanOrEqual(80);
  await label.hover();
  await expect(page.getByTestId("v12-tooltip")).toContainText("A long step name that cannot fit");
});
