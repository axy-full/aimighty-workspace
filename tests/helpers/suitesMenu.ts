import type { Page } from "@playwright/test";

/**
 * In the compact phone header, Suites and Search wait behind the context
 * badge (app/phone-chrome.css): one tap opens them in either orientation.
 * On a desktop they are in the header already, and this does nothing.
 */
export async function openSuitesMenu(page: Page) {
  const badge = page.getByTestId("suites-menu");
  if (!(await badge.isVisible())) return;
  if ((await badge.getAttribute("aria-expanded")) !== "true") await badge.click();
}

/** Closes that menu again where it is open, so it covers nothing a spec taps next. */
export async function closeSuitesMenu(page: Page) {
  const badge = page.getByTestId("suites-menu");
  if ((await badge.isVisible()) && (await badge.getAttribute("aria-expanded")) === "true") await badge.click();
}
