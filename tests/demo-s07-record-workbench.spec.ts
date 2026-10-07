import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { seedBoard, desktop } from "./helpers/s03-board";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTextIn } from "./helpers/s07Floors";

/*
 * Stream 7 · the Project record, the docked panel's second tab (README § 3.1 n). Real local ENGINE_MOCK=1 server: the
 * brief as the draft holds it, an empty record before anything is approved, then (after Atomik is asked at its price)
 * the thinking as an approval priced → settled and the proposal as an open decision, and the spend against the budget
 * ("no budget" until one is set). Nothing is approved or spent here. Neutral names only. Desktop only (phones: stream 10).
 */
const SHOTS = process.env.S07_SHOTS || join(tmpdir(), "claude-s07-shots");
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
};

test("the Record: the brief, nothing approved yet, no budget; then the thinking priced → settled and the proposal as an open decision", async ({ page }, info) => {
  test.skip(!desktop(page), "the board canvas is desktop only (phones open the project's Record, stream 10)");
  const { project } = await seedBoard(page);
  await forbidPaidWork(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const dock = page.getByTestId("board-agent-dock");
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) !== "true") await dock.getByTestId("agent-rail").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "true", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId("agent-tab-record").click();
  const record = page.getByTestId("board-record");
  await expect(record).toBeVisible();
  await expect(record.getByTestId("record-brief")).toHaveText("A short film about a morning market opening.");
  await expect(record).toContainText("16:9 · 24 fps");
  await expect(record.getByTestId("record-none")).toBeVisible();
  await expect(record.getByTestId("record-no-decisions")).toBeVisible();
  await expect(record.getByTestId("record-budget-line")).toHaveText(/^[\d.,]+ cr spent · no budget$/);
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, "record-empty", info);

  /* Ask Atomik at its price (the thinking is the first approval), and the proposal waits for a person. */
  await page.getByTestId("agent-tab-atomik").click();
  const panel = page.getByTestId("board-agent-panel");
  await panel.getByTestId("agent-input").fill("Two shots of the market opening at dawn.");
  await panel.getByTestId("agent-ask").click();
  await expect(panel.getByTestId("agent-proposal")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("agent-tab-record").click();
  const row = record.getByTestId("record-approval").first();
  await expect(row).toContainText("Atomik's thinking", { timeout: 30_000 });
  /* The ledger's figure once it settles; "settling" until then. The activity read gives the thinking no priced figure, so none is shown. */
  await expect(row.getByTestId("record-price")).toHaveText(/^(settling|[\d.,]+ cr)$/);
  await expect(record.getByTestId("record-decision").first()).toContainText(/\w/, { timeout: 30_000 });
  /* No vendor dollars, and no 80 % line, anywhere on the tab. */
  const text = await record.innerText();
  expect(text).not.toMatch(/\$\d/);
  expect(text).not.toMatch(/80 ?%/);
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await shot(page, "record", info);
  /* Open on a decision goes back to Atomik's lines, where the press is. */
  await record.getByTestId("record-decision").first().getByRole("button", { name: "Open" }).click();
  await expect(panel.getByTestId("agent-build")).toBeVisible();
});
