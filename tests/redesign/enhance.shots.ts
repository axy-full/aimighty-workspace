import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/* Make's Enhance switch (the owner's night queue, item 2) beside prototype 12's Make: the composer with it On and its tooltip, and the viewer's Enhanced label with the original words. */
test.afterAll(closePrototypeServer);

test("Make with Enhance On, and its tooltip", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page, { takes: 6 });
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("radio", { name: "Image" }).click();
  await page.getByTestId("v12-make-bar-input").fill("A paper kite over a grey sea");
  await expect(page.getByTestId("v12-make-go")).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  await page.getByTestId("v12-make-enhance").hover();
  await expect(page.getByTestId("v12-tooltip")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "enhance-make", "?view=make");
});

test("the viewer: Enhanced, with its original words", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page, { takes: 3 });
  await page.route(/\/api\/jobs\?limit=/, async (route) => {
    try {
      const reply = await route.fetch();
      const body = await reply.json() as { generations?: Record<string, unknown>[] };
      const a = body.generations?.[0];
      if (a) a.params = { ...(a.params as object), enhanced: true, rawPrompt: "a kite over a grey sea" };
      await route.fulfill({ response: reply, json: body });
    } catch { await route.fallback().catch(() => undefined); }
  });
  await page.goto("/suites?view=make&viewer=1");
  await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("v12-make-viewer-see-original").click();
  await expect(page.getByTestId("v12-make-viewer-original")).toBeVisible();
  await page.waitForTimeout(800);
  await captureBeside(page, "enhance-viewer", "?view=make&viewer=1");
});
