import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { noBannedNames, everySpendButtonPriced, SHOTS } from "./helpers/r1-gaps";
import { DESKTOP, bringIntoView, seedShots, take, textReadsAtFloor } from "./helpers/gaps-l1";
import { smallText } from "./phoneFloors";
import { join } from "node:path";
import { tmpdir } from "node:os";

/*
 * Gaps, lane 1 · Takes (design/particl-graphite "Gaps B frames": a take in review, reject with a reason, the Undo toast).
 * The take that waits shows Approve, Reject and "Change with words · N cr" (the free edit quote's price); Reject asks why
 * with chips and a free line, and says "Reject · spends nothing"; the rejection puts an Undo in the toast. Everything is
 * judged through the review trail and a take note (mocked in the browser); nothing paid is ever sent. Neutral words only.
 */
const PHONE = "phone widths open the project's Record and its review is the phone's own screen (tests/r1-gap-phone-fix-states-workbench.spec.ts); the board canvas is desktop only";
const frame = (page: import("@playwright/test").Page, name: string, project: string) => {
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: `${process.env.GAPS_L1_SHOTS || join(tmpdir(), "claude-gaps-l1-shots")}/l1-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" });
};

test("a take in review: Approve, Reject, Change with words priced from the quote; nothing is sent until a person presses", async ({ page }, info) => {
  test.skip(!DESKTOP(page), PHONE);
  const { project, paid, generations, shotIds } = await seedShots(page);
  /* Shot 1's waiting take is a clip, so Change with words is Seedance Edit and carries its quote. */
  generations.splice(0, 1, take("tk-s1-v1", shotIds[0], 1, { kind: "video", model: "dreamina-seedance-2-5-260628", params: { duration: 5, resolution: "1080p" }, creditsBilled: 43 }));
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ estimatedCredits: 12, price: 12, unit: "cr", fingerprint: "a".repeat(64) }) });
  });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const review = page.getByTestId("take-review");
  await expect(review).toBeVisible();
  await bringIntoView(page, review);
  await expect(review.getByTestId("take-approve")).toHaveText("Approve");
  await expect(review.getByTestId("take-reject")).toHaveText("Reject");
  await expect(review.getByTestId("take-change-words")).toContainText("Change with words");
  await expect(review.getByTestId("take-change-price")).toHaveText("up to 12 cr");
  await expect(review.getByTestId("take-versions-go")).toBeVisible();
  await expect.poll(() => asked.find((q) => q.task === "edit")).toMatchObject({ task: "edit", sourceGenId: "tk-s1-v1" });
  /* The page has one filled button on the card: Approve. */
  await expect(review.locator(".gx-take-btn--approve")).toHaveCSS("background-color", "rgb(10, 132, 255)");
  await frame(page, "takes", info.project.name);
  await everySpendButtonPriced(page);
  await noBannedNames(page);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  expect(await textReadsAtFloor(page, '[data-testid="take-review"]'), "text under 55% white").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});

test("reject with a reason: chips and a free line, 'Reject · spends nothing', then the Undo toast brings the take back", async ({ page }, info) => {
  test.skip(!DESKTOP(page), PHONE);
  const { project, reviews, notes, paid } = await seedShots(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const review = page.getByTestId("take-review");
  await expect(review).toBeVisible();
  await bringIntoView(page, review);
  await review.getByTestId("take-reject").click();
  const panel = review.getByTestId("take-reject-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("take-reject-confirm")).toHaveText("Reject · spends nothing");
  await expect(review.getByTestId("take-approve")).toHaveCount(0);

  /* Nothing said: the line says why, and nothing is written. */
  await panel.getByTestId("take-reject-confirm").click();
  await expect(panel.getByTestId("take-reason-hint")).toHaveText("Say why you are rejecting it.");
  expect(reviews).toEqual([]);

  /* A chip and a line. */
  await panel.getByTestId("take-reject-chip").nth(1).click();
  await expect(panel.getByTestId("take-reject-said")).toHaveText("Wrong framing");
  await panel.getByTestId("take-reason").fill("The feet slide");
  /* The panel fits inside the card. */
  const inside = await review.evaluate((card) => { const p = card.querySelector('[data-testid="take-reject-panel"]')!.getBoundingClientRect(); return card.getBoundingClientRect().bottom - p.bottom; });
  expect(inside).toBeGreaterThanOrEqual(0);
  await frame(page, "reject", info.project.name);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  expect(await textReadsAtFloor(page, '[data-testid="take-review"]'), "text under 55% white").toEqual([]);
  await panel.getByTestId("take-reject-confirm").click();
  await expect.poll(() => reviews).toEqual([{ id: "tk-s1-v1", state: "changes" }]);
  await expect.poll(() => notes).toEqual([{ genId: "tk-s1-v1", text: "Wrong framing; The feet slide" }]);

  /* The Undo toast, top right of the canvas. */
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Shot 1 · v1 rejected");
  const undo = toast.getByRole("button", { name: /Undo/ });
  await expect(undo).toBeVisible();
  const box = (await toast.boundingBox())!;
  const view = page.viewportSize()!;
  /* Beside the docked Atomik panel (340 px), not under it. */
  expect(box.x + box.width).toBeGreaterThan(view.width - 400);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width - 340);
  expect(box.y).toBeLessThan(120);
  await frame(page, "undo", info.project.name);
  await undo.click();
  await expect.poll(() => reviews).toEqual([{ id: "tk-s1-v1", state: "changes" }, { id: "tk-s1-v1", state: "" }]);
  expect(paid).toEqual([]);
});

test("Cancel leaves the take as it was and writes nothing", async ({ page }) => {
  test.skip(!DESKTOP(page), PHONE);
  const { project, reviews, notes, paid } = await seedShots(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const review = page.getByTestId("take-review");
  await review.getByTestId("take-reject").click();
  await review.getByTestId("take-reject-chip").first().click();
  await review.getByTestId("take-reject-cancel").click();
  await expect(review.getByTestId("take-reject-panel")).toHaveCount(0);
  await expect(review.getByTestId("take-approve")).toBeVisible();
  expect(reviews).toEqual([]);
  expect(notes).toEqual([]);
  expect(paid).toEqual([]);
});
