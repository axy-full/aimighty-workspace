import { expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./newInterface";
import { smallTargets, smallText } from "../phoneFloors";

/**
 * Activity, Memory and Skills have no phone screen until after the demo. Their phone addresses show one clean page:
 * the title, one plain line, a Home button; never a broken layout or a silent redirect to Home. Signs in, opens the
 * address, asserts the page and its floors (text 12 px and up, targets 44 px and up, no sideways scroll), then that
 * Home really is one press away.
 */
export async function expectLargerScreen(page: Page, address: string, title: "Activity" | "Memory" | "Skills") {
  await signInWithNewInterface(page.request);
  await page.goto(address);
  const larger = page.getByTestId("phone-larger");
  await expect(larger).toBeVisible();
  await expect(page.getByTestId("phone-larger-title")).toHaveText(title);
  await expect(page.getByTestId("phone-title")).toHaveText(title);
  await expect(page.getByTestId("phone-larger-line")).toHaveText("Open this on a larger screen.");
  /* Not Home with no word, and no half-drawn control room under it. */
  await expect(page.getByTestId("phone-home")).toHaveCount(0);
  await expect(page.locator(".cr")).toHaveCount(0);
  const home = page.getByTestId("phone-larger-home");
  await expect(home).toHaveText("Home");
  const box = await home.boundingBox();
  expect(box && box.width >= 44 && box.height >= 44, `Home button ${JSON.stringify(box)} is under 44×44`).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  expect(await smallTargets(page, ".ph-app"), "targets under 44×44").toEqual([]);
  if (process.env.R1_PHONE_SHOTS) await page.screenshot({ path: `${process.env.R1_PHONE_SHOTS}/larger-${title}-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png` });
  await home.click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
  await expect(page.getByTestId("phone-larger")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("suite")).toBeNull();
}
