import { test, expect } from "@playwright/test";
import { setSite } from "./helpers/visitorV12";
import { walkSizes } from "./helpers/brandLarge";

/**
 * Large screens (owner, 15 Oct 2026, 22:30), for the screens that draw the shared logo without the app's header: the error page and the guest header. Each draws a vector mark and a wordmark
 * with at least the pixels it is drawn with, at the owner's sizes and at a pixel ratio of 1 and of 2, at its own size, with its header spanning the window and nothing scrolling sideways
 * (tests/helpers/brandLarge.ts). The wordmark is PNG only in public/brand today: the owner is to supply an SVG wordmark. Local ENGINE_MOCK server only.
 */
test("the error page's logo is sharp, its own size and its header spans the window at the large-screen sizes, at 1x and 2x", async ({ browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all the large-screen sizes");
  test.setTimeout(420_000);
  await walkSizes(browser, "the error page", async (page) => {
    await page.goto("/this-page-is-not-there");
    return { logo: page.locator("header .gx-brand .brand-logo"), header: page.locator("header").first() };
  });
});

test("the guest header's logo is sharp, its own size and its header spans the window at the large-screen sizes, at 1x and 2x", async ({ browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project walks all the large-screen sizes");
  test.setTimeout(420_000);
  await setSite({ guestHome: true, visitorPages: false });
  try {
    await walkSizes(browser, "the guest header", async (page) => {
      await page.goto("/?guest=1");
      const header = page.getByTestId("guest-header");
      await expect(header).toBeVisible({ timeout: 60_000 });
      return { logo: header.getByTestId("guest-brand").locator(".brand-logo"), header };
    });
  } finally { await setSite({}); }
});
