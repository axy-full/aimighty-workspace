import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { isCompact } from "./helpers/shellMode";

/*
 * The new-interface switch off (lib/newInterface.ts), which is every customer workspace: exactly today's app at every size. The header and the
 * screen are the shell root's own children, the phone app on phones, and nothing of a build behind the switch anywhere. Moved here from
 * tests/shell-v12-workbench.spec.ts when the prototype-12 build was deleted (owner, 23 Oct 2026, 19:35), as the switch-off browser check the
 * v31.16 build behind the same switch is held to from its first screen.
 */

async function noHorizontalOverflow(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "no horizontal overflow").toBeLessThanOrEqual(0);
}

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
