import { test, expect, type Page } from "@playwright/test";
import { signInToRedesign } from "./helpers/newInterface";
import { signInLocally } from "./helpers/workbenchLocal";
import { isCompact } from "./helpers/shellMode";

/*
 * The new interface's frame (components/v12/V12Shell.tsx, docs/redesign-plan.md › "One shell, two frames").
 * Switch on, at desktop sizes: the .v12 root, its 56 px header slot holding today's header, today's screen in its body.
 * Switch on, at phone sizes: the phone app, as today. Switch off, at every size: exactly today's app, no .v12 anywhere.
 */

async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "no horizontal overflow").toBeLessThanOrEqual(0);
}

test("switch on: the new frame at desktop sizes, today's phone app at phone sizes", async ({ page }, info) => {
  await signInToRedesign(page.request);
  await page.goto("/suites?view=home");
  await expect(page.locator(".gx")).toBeVisible();
  if (isCompact(info)) {
    await expect(page.getByTestId("phone-app")).toBeVisible();
    await expect(page.locator(".v12")).toHaveCount(0);
    await noHorizontalOverflow(page);
    return;
  }
  const root = page.getByTestId("v12-root");
  await expect(root).toBeVisible();
  await expect(root).toHaveClass(/\bv12\b/);
  /* The 56 px header slot holds today's header for now (A2 replaces it). */
  const head = page.getByTestId("v12-head");
  await expect(head.locator(".gx-header")).toBeVisible();
  const box = await head.boundingBox();
  expect(box?.height).toBe(56);
  expect(box?.y).toBe(0);
  /* Today's Home inside the body, filling the window below the header. */
  const screen = page.getByTestId("v12-body").getByTestId("screen");
  await expect(screen).toHaveAttribute("data-screen", "home");
  const view = page.viewportSize()!;
  const body = await page.getByTestId("v12-body").boundingBox();
  expect(Math.round(body!.y + body!.height)).toBe(view.height);
  await expect(page.getByTestId("phone-app")).toHaveCount(0);
  await noHorizontalOverflow(page);
  /* With no layer of the new frame open, Esc still reaches today's handlers: ⌘K opens Search and Esc closes it. */
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByTestId("atomik-palette");
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});

test("switch off: exactly today's app at every size, and no .v12 anywhere", async ({ page }, info) => {
  await signInLocally(page.request);
  await page.goto("/suites?view=home");
  await expect(page.locator(".gx")).toBeVisible();
  if (isCompact(info)) await expect(page.getByTestId("phone-app")).toBeVisible();
  else {
    /* Today's structure: the header and the screen are the shell root's own children, with nothing between. */
    await expect(page.locator(".gx > .gx-header")).toBeVisible();
    await expect(page.locator(".gx > [data-testid=screen]")).toHaveAttribute("data-screen", "home");
  }
  await expect(page.locator(".v12, [data-testid=v12-root], [data-testid=v12-portal]")).toHaveCount(0);
  await noHorizontalOverflow(page);
});
