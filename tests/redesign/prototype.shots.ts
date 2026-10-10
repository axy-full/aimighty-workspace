import { test, expect } from "@playwright/test";
import { closePrototypeServer, openPrototype } from "../helpers/redesignShots";

/* The harness itself: the prototype renders offline from design/particl-prototype-12 at both review sizes. */
test.afterAll(closePrototypeServer);

test("the prototype renders offline", async ({ page }, info) => {
  await openPrototype(page, "?view=board&stage=Storyboard");
  const text = (await page.locator("body").innerText()).trim();
  expect(text.length).toBeGreaterThan(50);
  await page.screenshot({ path: info.outputPath("prototype.png") });
});
