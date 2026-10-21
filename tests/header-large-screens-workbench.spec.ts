import { test } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { walkSizes } from "./helpers/brandLarge";

/** The app header's logo at the large-screen sizes (tests/helpers/brandLarge.ts): sharp, its own size, the header spanning the window. The new interface's header is checked in tests/board-large-screens-workbench.spec.ts. */
test("the app header's logo is sharp, its own size and its header spans the window at the large-screen sizes, at 1x and 2x", async ({ browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all the large-screen sizes");
  test.setTimeout(420_000);
  await walkSizes(browser, "the app header", async (page) => {
    await signInLocally(page.request, "Header Large Tester");
    await page.goto("/suites?view=home");
    const header = page.locator("header.gx-header").first();
    return { logo: header.locator(".gx-brand .brand-logo").first(), header };
  });
});
