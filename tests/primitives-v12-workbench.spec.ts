import { test, expect } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * The new interface's shared pieces (components/v12/ui), each on the test-only page app/(test)/v12-primitives (a 404
 * outside a local ENGINE_MOCK=1 development server). The new frame is desktop-only, so this runs at the desktop sizes.
 */

test.beforeEach(async ({ page }, info) => {
  test.skip(isCompact(info), "the new frame is desktop-only; the phone sizes are covered by tests/shell-v12-workbench.spec.ts");
  const res = await page.goto("/v12-primitives");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByRole("heading", { name: "Shared pieces" })).toBeVisible();
});

test("tooltips: name, line, shortcut and price, on hover after a delay and on keyboard focus, kept on screen", async ({ page }) => {
  const tip = page.getByTestId("v12-tooltip");
  await page.getByTestId("tip-target").hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Home");
  await expect(tip).toContainText("Your boards and what needs you.");
  await expect(tip.locator("kbd")).toHaveText(["G", "H", "⌘1"]);
  await expect(page.getByTestId("tip-target")).toHaveAttribute("aria-describedby", await tip.getAttribute("id") ?? "");
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  /* Keyboard focus shows it too; Esc hides it. */
  await page.getByTestId("tip-target").focus();
  await page.keyboard.press("Tab");
  await expect(tip).toContainText("Download");
  await expect(tip).toContainText("Free");
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);

  /* An icon button's accessible name is its tooltip's name. */
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");

  /* At the right edge it stays inside the window. */
  await page.getByTestId("icon-edge").hover();
  await expect(tip).toBeVisible();
  await expect.poll(async () => { const b = await tip.boundingBox(); return b ? b.x + b.width : 9e9; }).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
});

test("the segment moves with arrow keys, and pills and keys render", async ({ page }) => {
  const group = page.getByRole("radiogroup", { name: "View" });
  await group.getByRole("radio", { name: "Canvas" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
  await expect(group.getByRole("radio", { name: "List" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("segment-value")).toHaveText("strip");
  await expect(page.getByTestId("pill-activity")).toContainText("2 need you · 3 running");
  const height = await page.getByTestId("pill-activity").evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBe(32);
});

test("a menu: arrow keys, Enter runs an item and closes it; Esc and an outside click close it; focus comes back", async ({ page }) => {
  const opener = page.getByTestId("open-menu");
  await opener.click();
  const menu = page.getByRole("menu", { name: "Board menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("menu-picked")).toHaveText("duplicate");
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(menu).toHaveCount(0);
});

test("Esc closes the top-most layer first: menu, then dialog, then the join sheet's order, then tool, selection, drawer", async ({ page }) => {
  const stack = page.getByTestId("v12-stack");
  await page.getByTestId("layer-drawer").click();
  await page.getByTestId("layer-selection").click();
  await page.getByTestId("layer-tool").click();
  await expect(stack).toHaveText("Open: tool,selection,drawer");

  /* A dialog, and a menu opened from inside it: the menu goes first, then the dialog, which keeps what was typed. */
  await page.getByTestId("open-dialog").click();
  const dialog = page.getByRole("dialog", { name: "Rename board" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("dialog-input")).toBeFocused();
  await page.getByTestId("dialog-menu").click();
  await expect(page.getByRole("menu", { name: "More" })).toBeVisible();
  await expect(stack).toHaveText("Open: menu,menu,tool,selection,drawer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "More" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("open-dialog")).toBeFocused();

  /* The join sheet sits above menus and the rest. */
  await page.getByTestId("open-join").click();
  await expect(stack).toHaveText("Open: join,tool,selection,drawer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Join Particl to keep going" })).toHaveCount(0);

  for (const left of ["selection,drawer", "drawer", "nothing"]) {
    await page.keyboard.press("Escape");
    await expect(stack).toHaveText(`Open: ${left}`);
  }
});

test("a dialog keeps Tab inside it, and its scrim closes it; the bottom sheet sits on the bottom edge", async ({ page }) => {
  await page.getByTestId("open-dialog").click();
  const dialog = page.getByRole("dialog", { name: "Rename board" });
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.mouse.click(10, 10);
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("open-sheet").click();
  const sheet = page.getByRole("dialog", { name: "Bottom sheet" });
  await expect(sheet).toBeVisible();
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await sheet.boundingBox();
  expect(Math.abs(box!.y + box!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("toasts: bottom-centre, Undo runs from the button or ⌘Z, a plain one leaves after 2.6 s", async ({ page }) => {
  const toast = page.getByTestId("v12-toast");
  await page.getByTestId("toast-undo").click();
  await expect(toast).toContainText("Shot 3 removed");
  const box = (await toast.boundingBox())!;
  const view = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThanOrEqual(1);
  expect(box.y + box.height).toBeGreaterThan(view.height - 80);
  await page.getByTestId("v12-toast-action").click();
  await expect(page.getByTestId("undone")).toHaveText("1");
  await expect(toast).toHaveCount(0);

  await page.getByTestId("toast-undo").click();
  await expect(toast).toBeVisible();
  await page.mouse.click(5, 300);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("undone")).toHaveText("2");

  await page.getByTestId("toast-view").click();
  await expect(page.getByTestId("v12-toast-action")).toHaveText("View");

  await page.getByTestId("toast-plain").click();
  await expect(toast).toHaveText("Board renamed");
  await page.mouse.move(5, 300);
  await expect(toast).toHaveCount(0, { timeout: 4_000 });
});

test("the tab title reads (N ready) Particl and goes back when they are seen", async ({ page }) => {
  await page.getByTestId("ready-more").click();
  await expect(page).toHaveTitle("(1 ready) Particl");
  await page.getByTestId("ready-more").click();
  await expect(page).toHaveTitle("(2 ready) Particl");
  await page.getByTestId("ready-none").click();
  await expect(page).toHaveTitle("Particl");
});

test("under reduced motion nothing animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("open-menu").click();
  const menu = page.getByRole("menu", { name: "Board menu" });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await page.getByTestId("toast-plain").click();
  expect(await page.getByTestId("v12-toast").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
});
