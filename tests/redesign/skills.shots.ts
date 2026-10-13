import { test, expect } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/*
 * The "/" skills list (redesign P6-d) beside prototype 12's `?view=home&q=%2F`. The skills routes are answered by fixtures; nothing is
 * generated or spent.
 */
test.afterAll(closePrototypeServer);

const SKILL = {
  id: "skill_wave1", slug: "wave-runner-spot", name: "Wave runner spot", description: "A short spot for a product", scope: "workspace", status: "active", version: 1,
  byYou: true, byName: null, editedByYou: true, editedByName: null, archivedByYou: false, archivedByName: null, archivedAt: null, createdAt: 1, updatedAt: 2, canChangeScope: true,
  template: { parameters: [{ key: "product", label: "Product", default: "Red high-tops" }], steps: [{ kind: "image", title: "Still of {{product}}", prompt: "A still of {{product}}", model: "nano-banana-2", params: {} }] },
};

test("skills · '/' over the Home bar", async ({ page }) => {
  test.setTimeout(240_000);
  await seedHome(page);
  await page.route((url) => url.pathname.startsWith("/api/atomik/skills"), (route) => {
    const r = route.request();
    if (r.method() === "GET") return route.fulfill({ json: { skills: [SKILL] } });
    return route.fulfill({ json: { preview: { steps: [{ index: 0, kind: "image", title: "Still", prompt: "x", model: "nano-banana-2", label: "Nano Banana 2", params: {}, estCredits: 6, estUsd: null, swapped: false }], problems: [], values: {} } } });
  });
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("v12-home-bar-input").fill("/");
  await expect(page.getByTestId("v12-home-bar-skills")).toBeVisible();
  await expect(page.getByTestId("v12-home-bar-skill")).toHaveCount(9);
  for (const price of await page.locator(".v12-bar-skill-price").all()) await expect(price).not.toHaveText("…", { timeout: 30_000 });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
  await captureBeside(page, "skills", "?view=home&q=%2F");
});
