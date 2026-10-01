import { expect, type Page } from "@playwright/test";

/**
 * In the compact phone header, Suites and Search wait behind the context
 * badge (app/phone-chrome.css): one tap opens them in either orientation.
 * On a desktop they are in the header already, and this does nothing.
 *
 * The tap is checked, not assumed: it is made once React is listening on the
 * badge (hydrated), and it counts once the badge says the menu is open
 * (aria-expanded). A tap that did not open it is made again. On a dev server
 * that is still compiling routes on their first use, Fast Refresh re-renders
 * the page under a spec and can reload it, and a tap made in that moment did
 * nothing or was undone; the old helper went on to look for a tab that was
 * never shown.
 */
export async function openSuitesMenu(page: Page) {
  const badge = page.getByTestId("suites-menu");
  if (!(await badge.isVisible())) return;
  await expect(async () => {
    expect(await badge.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps")), undefined, { timeout: 5_000 }), "React is listening on the badge").toBe(true);
    if ((await badge.getAttribute("aria-expanded", { timeout: 5_000 })) !== "true") await badge.click({ timeout: 5_000 });
    await expect(badge, "the badge says the menu is open").toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
}

/** Closes that menu again where it is open, so it covers nothing a spec taps next; checked the same way. */
export async function closeSuitesMenu(page: Page) {
  const badge = page.getByTestId("suites-menu");
  if (!(await badge.isVisible())) return;
  await expect(async () => {
    if ((await badge.getAttribute("aria-expanded", { timeout: 5_000 })) === "true") await badge.click({ timeout: 5_000 });
    await expect(badge, "the badge says the menu is closed").toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
}

/**
 * Taps a suite's tab (Studio, Gen, Atomik…), on a phone through the menu, and
 * checks the tap took: that tab is then the selected one. A reload that lands
 * after the menu opened closes it again, and a tap made in that moment is
 * lost, so a tap that did not take is made again from the menu. Tapping the
 * suite already shown again adds no history entry (the shell writes the
 * address only when it changes).
 */
export async function tapSuiteTab(page: Page, name: string) {
  const tab = page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name });
  await expect(async () => {
    await openSuitesMenu(page);
    await tab.click({ timeout: 5_000 });
    await expect(tab, `${name} is the selected suite`).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}
