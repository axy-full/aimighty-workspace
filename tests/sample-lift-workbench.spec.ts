import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedFinishedProduction, watchPaidRequests } from "./helpers/s12-sample";
import { isCompact } from "./helpers/shellMode";
import { LIFT_LINE, SAMPLE_LINE } from "../lib/demo/sample";

/*
 * The one-run lift (owner, 7 Oct; lib/demo/lift.server.ts), on a real marked sample in a local ENGINE_MOCK workspace.
 * Settings › Spending rules shows the owner the Sample mark with Lift for one run; pressed (free), it reads "Lifted for
 * one run" with Put back now and a record row, and the sample's board says "Lifted for one run · comes back on when it
 * ends" and opens its controls for the lifter. Put back, the board says the sample's own line again. Nothing paid is
 * sent at any point: no Atomik ask, no render.
 */
const SHOTS = process.env.SAMPLE_LIFT_SHOTS || join(tmpdir(), "claude-sample-lift-shots");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the owner lifts the sample mark for one run in Settings, the board says so, and Put back now ends it", async ({ page }, info) => {
  test.skip(isCompact(info), "the board's line is the desktop board's: below the compact line the phone app draws no board");
  const paid = watchPaidRequests(page);
  const made = await seedFinishedProduction(page, { name: "Dunes" });
  const marked = await page.request.post("/api/demo/sample", { headers: made.headers, data: { action: "mark", draftId: made.project.id } });
  expect(marked.status(), await marked.text()).toBe(200);
  const size = info.project.name.replace("workbench-", "");
  mkdirSync(SHOTS, { recursive: true });

  /* Settings › Spending rules: the mark is on, and the owner may lift it. */
  await page.goto("/suites?view=workspace&ws=rules");
  const section = page.getByTestId("settings-sample-mark");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("settings-sample-state")).toContainText("On");
  await expect(section.getByTestId("settings-sample-state")).toContainText("Nothing in this workspace spends.");
  const lift = section.getByTestId("settings-sample-lift");
  await expect(lift).toHaveText("Lift for one run");
  await expect(lift).toBeEnabled();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await lift.click();
  await expect(section.getByTestId("settings-sample-state")).toContainText("Lifted for one run");
  await expect(section.getByTestId("settings-sample-state")).toContainText("For your next Atomik run on a board. Back on when it ends, or at");
  await expect(section.getByTestId("settings-sample-putback")).toBeVisible();
  const row = section.getByTestId("settings-sample-lift-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("You lifted it");
  await expect(row).toContainText("next run · still lifted");
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/settings-lifted-${size}.png` });

  /* The sample's board: the lift's line, and its controls open for the person who lifted it. */
  await page.goto(`/suites?project=${made.project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 30_000 });
  const pill = page.getByTestId("board-sample");
  await expect(pill).toHaveText(LIFT_LINE, { timeout: 30_000 });
  await expect(pill).toHaveAttribute("data-lifted", "true");
  await expect(page.getByTestId("board")).not.toHaveAttribute("data-sample", "1");
  const box = (await pill.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await pill.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/board-lifted-${size}.png` });

  /* Put back now: the record says when, and the board is the sample's again. */
  await page.goto("/suites?view=workspace&ws=rules");
  await page.getByTestId("settings-sample-putback").click();
  await expect(page.getByTestId("settings-sample-state")).toContainText("On");
  await expect(page.getByTestId("settings-sample-lift-row")).toContainText("put it back");
  await page.goto(`/suites?project=${made.project.id}&view=board`);
  await expect(page.getByTestId("board-sample")).toHaveText(SAMPLE_LINE, { timeout: 30_000 });
  await expect(page.getByTestId("board")).toHaveAttribute("data-sample", "1");

  expect(paid).toEqual([]);
});
