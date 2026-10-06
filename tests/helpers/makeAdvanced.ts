import { expect, type Page } from "@playwright/test";

/**
 * Make's short form keeps the extra settings (film chips, Enhance, resolution, draft, sound, voice, takes) in one folded
 * "Advanced" under the engine line's Change list, both closed whenever Make opens. A spec about one of them opens it first; this is idempotent, so a spec
 * that opened it already (or reopened Make) can call it again.
 */
export async function openAdvanced(page: Page) {
  /* Advanced sits under Change (the engine line's button, `gen-model`): open that list first when it is closed. */
  const change = page.getByTestId("gen-model");
  await expect(change).toBeVisible();
  if ((await change.getAttribute("aria-expanded")) !== "true") await change.click();
  const toggle = page.getByTestId("make-advanced-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("make-more")).toBeVisible();
}
