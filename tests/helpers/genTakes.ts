import { expect, type Page } from "@playwright/test";

/**
 * Gen's takes stepper, pressed `presses` times once Generate is priced and ready. Until then the line above the
 * stepper says why Generate waits ("Getting the live price…"). That line now keeps its height (GenView), so the
 * stepper stays put as the price lands; pressing only once the price is on the button keeps a spec from resting on
 * that alone: whatever comes or goes above the stepper mid-press moves it, and a press whose release lands off the
 * button is lost (Playwright checks only the press's first event).
 */
export async function moreTakes(page: Page, presses: number) {
  const go = page.getByTestId("gen-generate");
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(go).toHaveText(/\d (connected )?cr/);
  const more = page.getByTestId("gen-takes").getByRole("button", { name: "More", exact: true });
  for (let i = 0; i < presses; i++) await more.click();
}
