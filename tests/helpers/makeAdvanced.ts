import { expect, type Page } from "@playwright/test";

/**
 * Make's short form keeps the extra settings (film chips, Enhance, resolution, draft, sound, voice, takes) in one folded
 * "Advanced" that is closed whenever Make opens. A spec about one of them opens it first; this is idempotent, so a spec
 * that opened it already (or reopened Make) can call it again.
 */
export async function openAdvanced(page: Page) {
  const toggle = page.getByTestId("make-advanced-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("make-more")).toBeVisible();
}
