import { test, expect } from "@playwright/test";
import type { QueueItem } from "../../lib/control-room/queue";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { seedHome } from "../helpers/v12Home";

/* Home, signed in (redesign C2), beside the prototype's default view `?`. Neutral data of the test workspace's own. */
test.afterAll(closePrototypeServer);

const item = (id: string, title: string, credits: number): QueueItem => ({
  id, title, source: "held", where: "Board", at: Date.now() - 5 * 60_000,
  project: { productionId: "prod-x", draftId: null, name: "Harbour film" },
  price: { kind: "exact", credits }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: id, credits }, decline: null, open: { kind: "take", genId: id, draftId: null },
});

test("home beside the prototype", async ({ page }) => {
  test.setTimeout(300_000);
  await seedHome(page);
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: {
    items: [item("held:a", "Shot 4 · keyframe", 2), item("held:b", "Shot 6 · retake", 7), item("held:c", "Wide shot", 3)], decided: [], inCredits: true,
  } }));
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home-tile")).toHaveCount(6, { timeout: 90_000 });
  await expect(page.getByTestId("v12-home-start")).toHaveText(/Start · up to \d/, { timeout: 60_000 });
  /* Covers and stills have landed. */
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="v12-home"] img')).every((img) => img.complete), null, { timeout: 30_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await captureBeside(page, "home", "?");
});
