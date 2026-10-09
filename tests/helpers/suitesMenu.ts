import { expect, type Page } from "@playwright/test";

/**
 * In the compact phone header, Suites and Search wait behind the context
 * badge (components/graphite/phone.css): one tap opens them in either orientation.
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
  /* On a phone the pick closes the menu, so the tab is read while it is hidden. */
  const tab = page.getByRole("tablist", { name: "Suites", includeHidden: true }).getByRole("tab", { name, includeHidden: true });
  await expect(async () => {
    await openSuitesMenu(page);
    await tab.click({ timeout: 5_000 });
    await expect(tab, `${name} is the selected suite`).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * Goes somewhere through ⌘K search: Business, Viral and Crew left the header (header option B), and ⌘K is how they
 * are reached until their boards ship. Opens Search from the header (on a phone through the menu), types `query`,
 * and picks the row named `option`; checked by the dialog closing.
 */
export async function goViaSearch(page: Page, query: string, option: string | RegExp) {
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await openSuitesMenu(page);
      await page.getByTestId("header-search").click({ timeout: 5_000 });
    }
    await dialog.getByRole("textbox", { name: "Search" }).fill(query, { timeout: 5_000 });
    await dialog.getByRole("option", { name: option }).first().click({ timeout: 5_000 });
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * Crew review is not a ⌘K row (the design's search lists Home, the board's regions, Make, Atomik and Settings); until it is a
 * panel on the board, its room opens by its address, on the project already open.
 */
export async function goCrewReview(page: Page) {
  const url = new URL(page.url());
  url.searchParams.set("view", "crew");
  url.searchParams.set("cp", "room");
  await page.goto(url.toString());
}
